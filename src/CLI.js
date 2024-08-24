
const readline = require('readline');


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
  
  module.exports = CLI