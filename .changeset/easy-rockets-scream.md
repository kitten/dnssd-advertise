---
'dnssd-advertise': patch
---

Filter incoming messages by remote address manually to check for IPv6 zone match or subnet address on Linux. `SO_BINDTODEVICE` isn't accessible to us for Linux, which means that we have to manually filter incoming messages per socket.
