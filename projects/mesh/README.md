# Mesh

Trust Tasks and TSP without the internet: over LoRa radio, over Bluetooth LE, and carried by hand on a USB stick.

- Design: `docs/design.md`.
- Status: design written, not built.

## The idea

A TSP message is sealed and signed end to end, so whoever carries it needs to be trusted only to deliver it. A radio can carry it as well as the internet relay can. But today a sealed Trust Task is 1 to 2 KB, and a LoRa frame holds about 250 bytes. The TSP envelope also names sender and receiver in clear text, which everyone in range would hear.

This project adds a shared library, `packages/mesh-transport`, that implements trust-core's `Transport` over radio links:
- a lossless compact form of Trust Task documents that cuts messages to about a quarter of their size, with every proof still valid;
- the TSP envelope stripped on the air and rebuilt byte for byte on arrival, with fresh random-looking address tags instead of DIDs;
- fragmentation, selective acknowledgements and retries for lossy, half-duplex links;
- direct, flooded and gateway routes, where a gateway hands the exact TSP bytes to the internet relay;
- airtime budgets that keep to each region's rules;
- adapters for a simulated radio (used by every test), a LoRaWAN gateway through Semtech's UDP packet forwarder protocol, RAK's RUI3 AT modules, and later RNode boards and Bluetooth LE.

## The demo

1. **A door with no internet.** A guest presents a pass to a building door over LoRa. The door checks it offline and answers in under 2 seconds. An eavesdropper hears only sizes and random bytes.
2. **An attestation from a cabin.** A tenant with no signal sends a Settle attestation over LoRa to a gateway, which forwards it to the relay. The payer's agent receives an ordinary TSP message.
3. **By hand.** The gateway is down, so the message leaves in a sealed file on a USB stick.

It runs on the simulator. On real hardware it uses the convener's RAK hotspot miner (a LoRaWAN gateway) and one RAK3172 board.

## Note

A transmitting radio can be located. This project hides what you say and who you say it to. It doesn't hide where you are.
