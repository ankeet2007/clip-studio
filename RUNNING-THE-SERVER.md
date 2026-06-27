# Running the Server Again + WiFi Conditions

Everything you need for day-to-day use of Clip Studio on the phone.

---

## Restarting the server on the phone

All the setup (installing Termux, packages, the project files) is PERMANENT.
You never repeat it. To run the server again after closing Termux, it is just
ONE command.

1. Open Termux on the phone.

2. (Recommended) Stop Android from killing it:

       termux-wake-lock

3. Start the server:

       bash ~/myapp/start-server.sh

4. Read the line it prints, e.g.:

       On your tablet's browser open:  http://192.168.29.83:3000

5. On the TABLET, open that exact http://...:3000 address.

To stop the server later, press Ctrl+C in that Termux window.

IMPORTANT: the http://...:3000 address can change each time (see WiFi below),
so always use the address the start script prints THAT session — do not assume
it is still .83.

---

## WiFi conditions — what must be true

- Phone and tablet on the SAME WiFi network.
  The tablet reaches the phone by its local IP. Different networks (e.g. phone
  on mobile data, tablet on WiFi) = no connection.

- Router must allow device-to-device traffic.
  Most home routers do. Some "Guest" WiFi networks block devices from seeing
  each other — avoid using Guest WiFi for this.

- The phone's IP can change.
  The router hands out IPs via DHCP and they drift (that is why the tablet went
  .172 -> .34 and the phone landed on .83). So the :3000 URL is NOT fixed —
  re-check it each session from what the start script prints.

- Internet must be available.
  The server talks to the cloud Neon database and to YouTube (yt-dlp). No
  internet = the UI loads but clips will not process.

### Tip: avoid the changing-IP hassle
For a fixed address that never changes, set a static IP / DHCP reservation for
the phone in the router's admin settings (assign the phone's MAC address a
permanent IP like 192.168.29.83). Then the URL is always the same and you can
bookmark it on the tablet. Optional, but convenient.

---

## What you do NOT need to worry about

- The temporary download server on the tablet (port 8000) was only for the
  one-time file transfer. It is not part of running Clip Studio — ignore it.

- No re-downloading, no re-running setup-phone.sh, no re-installing Termux.
  Just the one start-server.sh command each time.

---

## Quick reference (on the phone)

- Start the server:   bash ~/myapp/start-server.sh
- Stop the server:    Ctrl+C in that Termux window
- Keep it alive:      termux-wake-lock   (run once before starting)
- Find current URL:   the start script prints http://<phone-ip>:3000 each time
