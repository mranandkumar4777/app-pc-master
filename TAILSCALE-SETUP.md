# Connect the phone from any network (Tailscale + password)

Tailscale gives your computer a permanent private address that your phone can reach
from anywhere (mobile data, other Wi-Fi). Nothing is exposed to the public internet.

## One-time setup
1. Install **Tailscale** on the computer and on the phone (free, tailscale.com). Sign in to the **same account** on both.
2. In Presenter click **📱 Phone**. The address marked **(Tailscale)** is the computer's permanent address (it starts with 100.).
3. Under "Set your own password", type a password (8+ characters) and click **Save password**.
4. In the Presenter Remote app, type that Tailscale address and the password, then tap **Connect**.
   The first time, click **Allow** on the computer. The app remembers everything after that: just open it.

## Notes
- Keep Tailscale switched on on both devices. Keep Presenter open on the computer.
- Same Wi-Fi still works with no Tailscale (scan the QR code or let the app search).
- 5 wrong passwords from one device locks it out for 10 minutes.
- Changing the password signs every phone out; they enter the new one once.
