# ZaynDrop v1.0

## Setup

1. Make sure Node.js is installed (nodejs.org — LTS version)
2. Double-click `setup.bat`
3. ZaynDrop opens automatically

## First launch

1. Enter your Anthropic API key in the home screen (sk-ant-...)
2. Click **Fill** to open the fulfillment window
3. Click **⟳ RUN FULL SCAN**
4. A browser window will open — **log in to eBay and Amazon manually**
5. Once logged in, ZaynDrop remembers the session for future scans

## Windows

- **Home** — launcher hub, API key settings
- **Scout** — product research (v1.1)
- **List** — listing generator (v1.1)  
- **Fill** — order fulfillment, tracking, buyer messages

## Fill pipeline

1. Scrapes eBay orders from Seller Hub
2. Opens each order detail page and reads the shipping address (no iframe issues)
3. Matches to Amazon purchase history
4. Places unmatched orders on Amazon hands-free
5. Pulls tracking numbers from Amazon
6. Marks shipped on eBay
7. Messages buyers

## Data location

All data stored in: `C:\Users\YourName\AppData\Roaming\zayndrop\zayndrop.db`
