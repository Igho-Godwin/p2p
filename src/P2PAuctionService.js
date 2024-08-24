const Hypercore = require('hypercore');
const Hyperbee = require('hyperbee');
const Hyperswarm = require('hyperswarm');
const DHT = require('hyperdht');
const crypto = require('crypto');

const RPC = require('./rpc');

class P2PAuctionService  {
  constructor(options = {}) {
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
    return true;
  }

  async getAuction(auctionId) {
    const auctionNode = await this.db.get(auctionId);
    if (!auctionNode) return null;

    const auction = auctionNode.value;
    if (auction.status === 'active' && Date.now() > auction.endTime) {        
     return this.endAuction(auctionId).value;
    }
    return auction;
  }

  async endAuction(auctionId) {
    const auctionNode = await this.db.get(auctionId);
    const auction = auctionNode.value;
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
    return auction;
  }
}

module.exports = P2PAuctionService