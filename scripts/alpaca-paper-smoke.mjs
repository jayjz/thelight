#!/usr/bin/env node

const PAPER_BASE_URL = "https://paper-api.alpaca.markets";
const DATA_STREAM_URL = "wss://stream.data.alpaca.markets/v2/test";
const key = process.env.ALPACA_API_KEY_ID?.trim();
const secret = process.env.ALPACA_API_SECRET_KEY?.trim();
const symbol = process.env.ALPACA_SYMBOL?.trim().toUpperCase() || "SPY";
const submit = process.argv.includes("--submit-order");

if (!key || !secret) {
  console.error("Missing ALPACA_API_KEY_ID or ALPACA_API_SECRET_KEY.");
  process.exitCode = 2;
} else if ((process.env.ALPACA_PAPER_BASE_URL?.trim() || PAPER_BASE_URL) !== PAPER_BASE_URL) {
  console.error("ALPACA_PAPER_BASE_URL must remain the fixed Alpaca paper domain.");
  process.exitCode = 2;
} else {
  const headers = { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };
  const account = await fetch(`${PAPER_BASE_URL}/v2/account`, { headers });
  if (account.status === 401 || account.status === 403) {
    console.error("Alpaca PAPER authentication failed.");
    process.exitCode = 3;
  } else if (!account.ok) {
    console.error(`Alpaca PAPER account check failed: ${account.status}.`);
    process.exitCode = 4;
  } else {
    const body = await account.json();
    console.log(JSON.stringify({ paper: true, account_status: body.status, trading_blocked: body.trading_blocked }, null, 2));
    const socket = new WebSocket(DATA_STREAM_URL);
    const closed = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for FAKEPACA test bar.")),
        60_000,
      );
      socket.addEventListener("message", (event) => {
        console.log("WS:", event.data);
        const messages = JSON.parse(event.data);
        for (const message of messages) {
          if (message.T === "success" && message.msg === "connected") {
            socket.send(JSON.stringify({ action: "auth", key, secret }));
          } else if (message.T === "success" && message.msg === "authenticated") {
            socket.send(JSON.stringify({ action: "subscribe", bars: ["FAKEPACA"] }));
          } else if (message.T === "b" && message.S === "FAKEPACA") {
            clearTimeout(timer);
            resolve(message);
          } else if (message.T === "error") {
            clearTimeout(timer);
            reject(new Error(`Market-data stream error: ${message.msg}`));
          }
        }
      });
      socket.addEventListener("error", () => reject(new Error("Market-data stream disconnected.")));
    }).finally(() => socket.close());
    console.log(JSON.stringify({ test_bar: closed }, null, 2));
    if (!submit) {
      console.log("No order submitted. Add --submit-order and ALPACA_PAPER_SMOKE_SUBMIT=YES to explicitly submit one paper market order.");
    } else if (process.env.ALPACA_PAPER_SMOKE_SUBMIT !== "YES") {
      console.error("Refusing order: ALPACA_PAPER_SMOKE_SUBMIT must equal YES.");
      process.exitCode = 5;
    } else {
      const clientOrderId = `ll-smoke-${Date.now()}`;
      const order = await fetch(`${PAPER_BASE_URL}/v2/orders`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ symbol, qty: "1", side: "buy", type: "market", time_in_force: "day", client_order_id: clientOrderId }),
      });
      console.log(JSON.stringify({ order_submitted: order.ok, response: await order.json() }, null, 2));
      if (!order.ok) process.exitCode = 6;
    }
  }
}
