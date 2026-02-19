# alpaca.positions

Get current Alpaca positions

```yaml
name: alpaca.positions
description: Get current Alpaca positions
admin_only: false
args:
  # no args
```

```javascript
import Alpaca from '@alpacahq/alpaca-trade-api';

const apiKey = secrets.get('ALPACA_API_KEY');
const apiSecret = secrets.get('ALPACA_API_SECRET');

const alpaca = new Alpaca({
  keyId: apiKey,
  secretKey: apiSecret,
  paper: true
});

async function getPositions() {
  try {
    const positions = await alpaca.getPositions();
    return JSON.stringify(positions);
  } catch (error) {
    console.error(error);
    return `Error: ${error.message}`;
  }
}

return await getPositions();
```
