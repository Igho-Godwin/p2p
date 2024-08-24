const crypto = require("crypto");

class RPC {
  constructor(conn) {
    this.conn = conn;
    this.handlers = new Map();
    this.conn.on("data", this.handleMessage.bind(this));
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
      this.sendResponse(id, { error: "Method not found" });
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
          this.conn.removeListener("data", handler);
          if (error) reject(new Error(error));
          else resolve(result);
        }
      };
      this.conn.on("data", handler);
    });
  }
}

module.exports = RPC;
