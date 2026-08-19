How to use?
```bash
cd dsh-demos/dsh-tutorial
node --import tsx ../../vendor/cordis/bin.js
```

lifecycle.ts
```bash
# cordis.yml already enables ./lifecycle.ts
node --import tsx ../../vendor/cordis/bin.js
```
Expected output:
```
heartbeat plugin loading
tick
tick
tick
heartbeat cleaned up
dispose
```
