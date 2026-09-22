# LIGHTLIGHT bounded equity relay contract

The local market-data relay remains the sole Alpaca stock WebSocket owner.
Each LIGHTLIGHT runtime connects only to that relay and requests its explicit
asset symbol. For the bounded `ema_rsi_v1` universe, the relay must merge the
downstream requests into one upstream Alpaca subscription derived from
`BOUNDED_US_EQUITY_ASSETS`:

`SPY`, `QQQ`, `IWM`, `AAPL`, `MSFT`.

The relay must not use a wildcard subscription. A read-only runtime fails
closed at startup when no local relay is configured; it never opens an Alpaca
upstream socket as a fallback. If the deployed relay cannot merge downstream
subscriptions yet, that merge capability is the remaining infrastructure
requirement before multi-symbol runtime launch.
