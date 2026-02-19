# alpaca.account

Gets the alpaca account

```yaml
name: alpaca.account
description: Gets the alpaca account
admin_only: false
args:
  # no args
```

```javascript
const apiKey = secrets.get('ALPACA_API_KEY');
  const apiSecret = secrets.get('ALPACA_API_SECRET');
  const alpaca = new Alpaca({
    keyId: apiKey,
    secretKey: apiSecret,
    paper: true
  });
  const account = await alpaca.getAccount();
  return JSON.stringify(account);
```
