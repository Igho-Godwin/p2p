const P2PAuctionService = require('./P2PAuctionService')
const CLI = require('./CLI')

async function main() {
    const service = new P2PAuctionService();
    await service.init();
  
    const cli = new CLI(service);
    await cli.start();
  }
  
  main().catch(console.error);