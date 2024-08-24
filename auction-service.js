const Hypercore = require('hypercore');
const Hyperbee = require('hyperbee');
const Hyperswarm = require('hyperswarm');
const DHT = require('hyperdht');
const crypto = require('crypto');
const readline = require('readline');
const EventEmitter = require('events');

class P2PAuctionService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.dht = new DHT();
    this.swarm = new Hyperswarm({ dht: this.dht });
    this.core = new Hypercore(options.dataPath || './auction-data');
    this.db = new Hyperbee(this.core, {
      keyEncoding: 'utf-8',
      valueEncoding: 'json',
    });
    this.topic = options.topic || crypto.randomBytes(32);
    this.peers = new Set();
    this.auctionTimers = new Map();
  }

  async init() {
    await Promise.all([this.core.ready(), this.db.ready()]);

    this.swarm.on('connection', this.handleConnection.bind(this));

    const discovery = this.swarm.join(this.topic);
    await discovery.flushed();

    console.log('P2P Auction Service initialized. Topic:', this.topic.toString('hex'));

    await this.restoreAuctionTimers();
  }

  handleConnection(conn) {
    const peer = new RPC(conn);
    this.peers.add(peer);
    conn.on('close', () => this.peers.delete(peer));

    peer.respond('createAuction', this.createAuction.bind(this));
    peer.respond('placeBid', this.placeBid.bind(this));
    peer.respond('getAuction', this.getAuction.bind(this));
    peer.respond('endAuction', this.endAuction.bind(this));
  }

  async restoreAuctionTimers() {
    for await (const { key, value } of this.db.createReadStream()) {
      const auction = value;
      if (auction.status === 'active' && auction.endTime > Date.now()) {
        this.setAuctionTimer(key, auction.endTime - Date.now());
      }
    }
  }

  setAuctionTimer(auctionId, duration) {
    const timer = setTimeout(() => this.endAuction(auctionId), duration);
    this.auctionTimers.set(auctionId, timer);
  }

  async createAuction(item, startPrice, durationSeconds) {
    const auctionId = crypto.randomUUID();
    const startTime = Date.now();
    const endTime = startTime + durationSeconds * 1000;
    const auction = {
      item,
      startPrice,
      startTime,
      endTime,
      bids: [],
      status: 'active',
    };

    await this.db.put(auctionId, auction);
    this.setAuctionTimer(auctionId, durationSeconds * 1000);
    this.emit('auctionCreated', { auctionId, auction });
    return auctionId;
  }

  async placeBid(auctionId, bidderName, amount) {
    const auction = await this.getAuction(auctionId);
    if (!auction) throw new Error('Auction not found');
    if (auction.status !== 'active') throw new Error('Auction is not active');
    if (Date.now() > auction.endTime) throw new Error('Auction has ended');
    if (amount <= auction.startPrice) throw new Error('Bid too low');
    if (auction.bids.length > 0 && amount <= auction.bids[auction.bids.length - 1].amount) {
      throw new Error('Bid must be higher than the current highest bid');
    }

    const newBid = { bidderName, amount, time: Date.now() };
    auction.bids.push(newBid);
    await this.db.put(auctionId, auction);
    this.emit('bidPlaced', { auctionId, bid: newBid });
    return true;
  }

  async getAuction(auctionId) {
    const auctionNode = await this.db.get(auctionId);
    if (!auctionNode) return null;

    const auction = auctionNode.value;
    if (auction.status === 'active' && Date.now() > auction.endTime) {
      return this.endAuction(auctionId);
    }
    return auction;
  }

  async endAuction(auctionId) {
    const auction = await this.getAuction(auctionId);
    if (!auction) throw new Error('Auction not found');
    if (auction.status !== 'active') return auction;

    auction.status = 'ended';
    if (auction.bids.length > 0) {
      const winningBid = auction.bids[auction.bids.length - 1];
      auction.winner = winningBid.bidderName;
      auction.winningBid = winningBid.amount;
    } else {
      auction.winner = null;
      auction.winningBid = null;
    }

    await this.db.put(auctionId, auction);

    const timer = this.auctionTimers.get(auctionId);
    if (timer) {
      clearTimeout(timer);
      this.auctionTimers.delete(auctionId);
    }

    this.emit('auctionEnded', { auctionId, auction });
    return auction;
  }
}

class RPC {
  constructor(conn) {
    this.conn = conn;
    this.handlers = new Map();
    this.conn.on('data', this.handleMessage.bind(this));
  }

  respond(method, handler) {
    this.handlers.set(method, handler);
  }

  async handleMessage(message) {
    const { method, params, id } = JSON.parse(message);
    const handler = this.handlers.get(method);
    if (handler) {
      try {
        const result = await handler(...params);
        this.sendResponse(id, { result });
      } catch (error) {
        this.sendResponse(id, { error: error.message });
      }
    } else {
      this.sendResponse(id, { error: 'Method not found' });
    }
  }

  sendResponse(id, response) {
    this.conn.write(JSON.stringify({ id, ...response }));
  }

  async request(method, ...params) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      this.conn.write(JSON.stringify({ method, params, id }));
      const handler = (message) => {
        const { id: responseId, result, error } = JSON.parse(message);
        if (responseId === id) {
          this.conn.removeListener('data', handler);
          if (error) reject(new Error(error));
          else resolve(result);
        }
      };
      this.conn.on('data', handler);
    });
  }
}

class CLI {
  constructor(service) {
    this.service = service;
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  async start() {
    while (true) {
      console.log('\nP2P Auction Service CLI');
      console.log('1. Create Auction');
      console.log('2. Place Bid');
      console.log('3. Get Auction Details');
      console.log('4. End Auction');
      console.log('5. Exit');

      const choice = await this.getValidInput('Enter your choice (1-5): ', CLI.validators.choice);

      switch (choice) {
        case 1:
          await this.handleCreateAuction();
          break;
        case 2:
          await this.handlePlaceBid();
          break;
        case 3:
          await this.handleGetAuction();
          break;
        case 4:
          await this.handleEndAuction();
          break;
        case 5:
          this.rl.close();
          process.exit(0);
      }
    }
  }

  async getValidInput(prompt, validator) {
    while (true) {
      const input = await this.askQuestion(prompt);
      const validationResult = validator(input);
      if (validationResult.isValid) {
        return validationResult.value;
      }
      console.log(validationResult.error);
    }
  }

  askQuestion(query) {
    return new Promise((resolve) => this.rl.question(query, resolve));
  }

  async handleCreateAuction() {
    const item = await this.getValidInput('Enter item name: ', CLI.validators.nonEmptyString);
    const startPrice = await this.getValidInput('Enter starting price: ', CLI.validators.positiveNumber);
    const durationSeconds = await this.getValidInput('Enter auction duration in seconds: ', CLI.validators.positiveInteger);
    const auctionId = await this.service.createAuction(item, startPrice, durationSeconds);
    console.log(`Auction created with ID: ${auctionId}`);
  }

  async handlePlaceBid() {
    const auctionId = await this.getValidInput('Enter auction ID: ', CLI.validators.nonEmptyString);
    const bidderName = await this.getValidInput('Enter bidder name: ', CLI.validators.nonEmptyString);
    const amount = await this.getValidInput('Enter bid amount: ', CLI.validators.positiveNumber);
    try {
      const result = await this.service.placeBid(auctionId, bidderName, amount);
      console.log(result ? 'Bid placed successfully' : 'Failed to place bid');
    } catch (error) {
      console.error('Error placing bid:', error.message);
    }
  }

  async handleGetAuction() {
    const auctionId = await this.getValidInput('Enter auction ID: ', CLI.validators.nonEmptyString);
    const auction = await this.service.getAuction(auctionId);
    if (auction) {
      console.log(JSON.stringify({
        ...auction,
        timeRemaining: auction.status === 'active' ? Math.max(0, auction.endTime - Date.now()) / 1000 : 0,
      }, null, 2));
    } else {
      console.log('Auction not found');
    }
  }

  async handleEndAuction() {
    const auctionId = await this.getValidInput('Enter auction ID to end: ', CLI.validators.nonEmptyString);
    try {
      const auction = await this.service.endAuction(auctionId);
      console.log('Auction ended:');
      console.log('Item:', auction.item);
      console.log('Winner:', auction.winner || 'No winner');
      console.log('Winning Bid:', auction.winningBid ? `$${auction.winningBid}` : 'No winning bid');
    } catch (error) {
      console.error('Error ending auction:', error.message);
    }
  }

  static validators = {
    nonEmptyString: (input) => {
      if (input.trim() === '') {
        return { isValid: false, error: 'Input cannot be empty. Please try again.' };
      }
      return { isValid: true, value: input.trim() };
    },
    positiveNumber: (input) => {
      const num = parseFloat(input);
      if (isNaN(num) || num <= 0) {
        return { isValid: false, error: 'Please enter a positive number.' };
      }
      return { isValid: true, value: num };
    },
    positiveInteger: (input) => {
      const num = parseInt(input, 10);
      if (isNaN(num) || num <= 0 || !Number.isInteger(num)) {
        return { isValid: false, error: 'Please enter a positive integer.' };
      }
      return { isValid: true, value: num };
    },
    choice: (input) => {
      const num = parseInt(input, 10);
      if (isNaN(num) || num < 1 || num > 5) {
        return { isValid: false, error: 'Please enter a number between 1 and 5.' };
      }
      return { isValid: true, value: num };
    },
  };
}

async function main() {
  const service = new P2PAuctionService();
  await service.init();

  const cli = new CLI(service);
  await cli.start();
}

main().catch(console.error);