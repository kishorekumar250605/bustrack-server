BusTrack Live Server
====================
Sends the conductor's live data (crowd, traffic, route deviation) to every passenger phone instantly, per bus ID.
No packages to install. Needs only Node.js (you already have it).

START THE SERVER
1. Unzip this folder anywhere (for example Documents\BusTrack-Server).
2. Windows: double-click start-server.bat
   Or in a terminal inside this folder: node server.js
3. It prints an address like:  ws://192.168.43.16:8080
4. Keep this window open while testing. Close it to stop the server.

CONNECT THE APP
1. Open the BusTrack app project, file src/config.js
2. Put the printed address in SERVER_URL, for example:
   export const SERVER_URL = 'ws://192.168.43.16:8080';
3. Save, then reload the app on every phone (shake phone > Reload, or press r in the Expo terminal).

RULES
- Laptop and all phones must be on the same Wi-Fi or hotspot.
- If Windows Firewall asks, click Allow (private networks).
- Android Studio emulator on the same laptop: use ws://10.0.2.2:8080
- If the Wi-Fi changes, the laptop address changes. Run the server again and update config.js.

CHECK IT WORKS
- Open http://<laptop address>:8080 in a phone browser (use http, not ws).
  It should show: BusTrack live server
- Conductor changes crowd / traffic / route on the Live tab, the passenger phone updates within a second.

HOW IT WORKS
- Port: 8080 (change PORT at the top of server.js)
- Max crowd per bus: 50 (change MAX)
- Message from conductor: {"type":"set","busId":"TN01N1072","crowd":7,"traffic":"Heavy","deviation":true}
  (any one or more of the three fields)
- A phone that connects later gets the current live data of all buses.
- Data is kept in memory. Restarting the server resets crowd to 0, traffic to Low, route to On route.

PUT THE SERVER ONLINE (so any phone on any network can connect)
1. Create a GitHub repository and upload server.js and package.json from this folder.
2. On render.com: New > Web Service > connect that repository.
   Runtime: Node.  Build command: (empty).  Start command: node server.js.  Instance: Free.
3. When it is Live, open its address (https://NAME.onrender.com) in a browser.
   It must show: BusTrack live server
4. In the app, src/config.js: SERVER_URL = 'wss://NAME.onrender.com'  (wss, not https)
- Free servers sleep after ~15 minutes idle; the first connection after that takes up to a minute.
- Hosting sets the port itself (the server reads the PORT variable).
