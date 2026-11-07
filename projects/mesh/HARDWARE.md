# Bringing up the real radios

This is the plan for running act 1 (and then acts 2 and 3) on the convener's RAK Helium miner and one RAK3172. Nothing here has been tried on the hardware yet. Each step says how to check it worked, and what to do if it didn't. Where a value comes from a source we haven't confirmed on hardware, the step says so.

Sources: the design (`docs/design.md`), sections 12.2, 14.2 to 14.7 and 22. Those sections in turn cite Semtech's packet forwarder `PROTOCOL.TXT` (v1.4), `sx1302_hal`'s `global_conf.json.sx1250.US915`, the READMEs of RAK's `udp-packet-forwarder` and `rak_common_for_gateway`, and RAK's RUI3 AT command manual (read through a summary only).

## What you need

- The RAK miner, its power supply, its antenna, and an Ethernet cable to your router.
- A second microSD card, 8 GB or more, and a card reader. The miner's own card stays untouched.
- A laptop on the same network as the miner, with this repository and `npm install` done.
- A RAK3172 board with USB, **US915 (high-frequency) variant**, with its antenna. RAK's evaluation board works. So does a WisBlock kit with a RAK4631-R core (the "-R" means RUI3 firmware).
- A USB data cable (not a charge-only one).

**Never let either radio transmit without its antenna attached.** It can damage the radio.

The rules we keep to (design 12.2, our reading of secondary sources, not legal advice): the 902 to 928 MHz band, at most 400 ms per frame, at most 10% of channel time per hour, 20 dBm conducted, stock antennas. The software enforces the frame limit and the hourly share. Without an amateur license, frames stay in this band, and encryption is allowed.

## 1. Check the miner

1. Read the label on the case. Open the case (the screws are underneath) and read the concentrator board on the Raspberry Pi:
   - **RAK2287** (V2, SX1302): you will use `MODEL=RAK7248`.
   - **RAK2245** (V1, SX1301): you will use `MODEL=RAK2245`.
   The concentrator is made for one band. Its label should say US915. If it says EU868 or AS923, stop: the channel plans here are for US915 (design 14.4).
2. Check the antenna is attached, and that it's the original.
3. Find the microSD card on the Pi inside. Take it out, label it ("Helium, original"), and put it away. Putting it back undoes everything below.

## 2. A second card with RAK's packet forwarder (design 14.7, path B)

1. On the laptop, open Raspberry Pi Imager. Choose Raspberry Pi 4 and **Raspberry Pi OS Lite (64-bit)**. In the settings, set a hostname (for example `miner`), a user and password, and turn SSH on. Write the card.
2. Put the card in the Pi, plug in Ethernet, then power. Find its address from your router, or try `ssh <user>@miner.local`.
3. On the Pi, turn on SPI and I2C (RAK's tools expect both): `sudo raspi-config`, then Interface Options, then SPI, Enable; then I2C, Enable. Reboot.
4. Install Docker, following Docker's instructions for Raspberry Pi OS (docs.docker.com). Check with `docker run --rm hello-world`.
5. Find the laptop's address on the LAN. On macOS: `ipconfig getifaddr en0` (or `en1`). Call it `LAPTOP`.
6. Run RAK's packet forwarder container, `rakwireless/udp-packet-forwarder`, pointed at the laptop:

   ```
   docker run -d --name udp-packet-forwarder --restart unless-stopped \
     --privileged --network host \
     -e MODEL=RAK7248 -e BAND=us_902_928 \
     -e SERVER_HOST=LAPTOP -e SERVER_PORT=1700 \
     rakwireless/udp-packet-forwarder
   ```

   Use `MODEL=RAK2245` for a V1. The variable names are from the container's README as the design read it on 2026-11-06. Check them against the README before you run this. The container finds the concentrator itself. If it can't, the README describes its `find_concentrator` tool.
7. Check: `docker logs udp-packet-forwarder` should show the concentrator starting, the gateway EUI, and the US915 channels. Note the EUI.

RAK's other installer, `rak_common_for_gateway`, does the same without Docker: choose the model, then set the server with `gateway-config`. Either works.

What the stock US915 configuration means for us (design 14.4): the gateway listens on 8 channels at 125 kHz and on **one 500 kHz channel at 904.6 MHz, SF8**. It transmits only between 923.0 and 928.0 MHz. So we use plan `us915-b`: nodes transmit on 904.6 MHz and listen on 923.3 MHz; the gateway transmits on 923.3 MHz. All at 500 kHz, SF8, coding rate 4/5, the public sync word, and normal IQ (`ipol: false` on the gateway's transmissions).

## 3. Check the laptop hears the miner

1. Let UDP port 1700 in through the laptop's firewall. On macOS, the first time `node` listens, allow it when asked.
2. Run:

   ```
   npm run mesh --workspace @zk-toip/mesh -- doctor --no-serial
   ```

   It listens on UDP 1700 for up to 15 seconds. You want to see your gateway's EUI with **downlink yes**. The forwarder sends PULL_DATA every 10 seconds; that's the downlink path.
3. If it says nothing arrived: check `SERVER_HOST` is the laptop's address (doctor prints the laptop's addresses), the container is running (`docker ps`), and the firewall. If it shows the gateway but **downlink NO**: the forwarder sends uplink but no PULL_DATA; check `SERVER_PORT`.
4. Then check the gateway will transmit for us. This sends one 12-byte test frame on 923.3 MHz at 20 dBm, so **the antenna must be on**:

   ```
   npm run mesh --workspace @zk-toip/mesh -- doctor --no-serial --tx-test
   ```

   You want `test transmission ok`. `TX_FREQ` means the gateway won't transmit on 923.3 MHz: its `tx_freq_min`/`tx_freq_max` must include it (the stock US915 configuration does). `TX_POWER` means its power table has no 20 dBm entry.

## 4. Check the RAK3172

1. Plug it in by USB. On macOS it appears as `/dev/tty.usbserial-*` or `/dev/tty.usbmodem*`.
2. Run:

   ```
   npm run mesh --workspace @zk-toip/mesh -- doctor
   ```

   You want the port listed as `RAK RUI3 AT firmware` with a version. If nothing answers `AT`: check the cable carries data, press the board's reset button, and run doctor again. Doctor probes at 115200 baud.
3. Switch it to LoRa P2P mode with plan `us915-b`, to check it accepts the settings:

   ```
   npm run mesh --workspace @zk-toip/mesh -- doctor --rak-p2p
   ```

   This sends, in order (design 14.6): `AT`, `AT+VER=?`, `AT+NWM=?`, then `AT+NWM=0` if it isn't in P2P mode already (the module restarts), `AT+SYNCWORD=3444`, `AT+IQINVER=0`, `AT+CAD=1`, `AT+P2P=923300000:8:2:0:8:20` (listen on 923.3 MHz, SF8, 500 kHz, coding rate 4/5, preamble 8, 20 dBm), and `AT+PRECV=65533` (listen continuously). It doesn't transmit. You want `P2P ok`.
4. If it fails with `AT_PARAM_ERROR`: some boards have a TCXO and some don't, and they need different RUI3 builds. Check the firmware matches the board. To put the module back in LoRaWAN mode later: `AT+NWM=1`.

Three things the design marks as unconfirmed, to watch for here: the form of `AT+SYNCWORD` (we send `3444` for the public sync word, 0x34); the largest `AT+PSEND` (we use 250 bytes); and the turnaround times (we guess 250 ms for the gateway and 300 ms for the RAK3172).

## 5. Act 1 over the radios

Two terminals on the laptop. The door's radio is the miner; Rosa's is the RAK3172.

```
# terminal 1: the Front Door
npm run mesh --workspace @zk-toip/mesh -- door --link gwmp

# terminal 2: Rosa, once the door says it is up
npm run mesh --workspace @zk-toip/mesh -- guest --link rak:/dev/tty.usbserial-XXXX
```

The door waits for the packet forwarder's PULL_DATA, then beacons a signed challenge every 15 seconds. The guest waits up to 60 seconds for a beacon, presents the pass, and prints `✓ the door opened`. Both print every frame with its RSSI and SNR.

The demo pass is valid every day, all day, in the laptop's time zone. Try `--days Mon-Fri --hours 12:00-14:00` on both to see the door refuse outside the window.

If the guest hears no beacon: the RAK3172 isn't hearing 923.3 MHz. Check its antenna, and that doctor `--rak-p2p` passed. If the door hears nothing from the guest: the gateway hears 500 kHz frames only on 904.6 MHz at SF8; check `doctor` showed US915. Start the boards a few meters apart; the design's test plan then measures at 2 m, 50 m, and as far as it works (design 18).

## 6. Acts 2 and 3 over the radios

The gateway and the door both use UDP port 1700, so stop the door first.

```
# terminal 1: the Lodge's gateway, with a relay on this machine (port 4361)
npm run mesh --workspace @zk-toip/mesh -- gateway --link gwmp

# terminal 2: the landlord's agent
npm run mesh --workspace @zk-toip/mesh -- receive

# terminal 3: Alice
npm run mesh --workspace @zk-toip/mesh -- attest --link rak:/dev/tty.usbserial-XXXX
```

Alice listens for the gateway's beacon (it beacons every 60 seconds), sends the attestation, and gets a custody receipt. The landlord's agent prints that it accepted it.

For act 3, stop the gateway and run `attest` again: with no gateway heard, the attestation waits in `.data/alice/outbox.json`. Then:

```
npm run mesh --workspace @zk-toip/mesh -- bundle export --out stick.toipbundle
npm run mesh --workspace @zk-toip/mesh -- bundle import stick.toipbundle --relay ws://localhost:4361/v1
```

The import needs a relay to post to. Start the gateway again (it starts the relay on port 4361), or point `--relay` at another relay. Keep `receive` running to see the landlord's agent accept it.

## 7. Undo

Power off the miner, swap the cards back, and power on. The Helium setup is as it was.
