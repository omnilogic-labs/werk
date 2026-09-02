# M5's remote end: sshd, tc, vim, and the same compiled `wp` the host runs.
# Built by run.ts with the freshly compiled dist/wp copied into the context.
# glibc: dist/wp links libc/libm/libdl/libpthread only, so bookworm is enough.
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server iproute2 vim coreutils procps \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd \
 && ssh-keygen -A \
 && useradd -m -u 1000 -s /bin/bash werk \
 && install -d -m 0700 -o werk -g werk /run/user/1000
COPY wp /usr/local/bin/wp
# netem <rtt-ms>: rtt/2 on egress (eth0 root) and rtt/2 on ingress (eth0
# ingress redirected to an ifb device), so the delay is symmetric. 0 clears.
RUN printf '%s\n' '#!/bin/sh' \
  'tc qdisc del dev eth0 root 2>/dev/null; tc qdisc del dev eth0 ingress 2>/dev/null; tc qdisc del dev ifb0 root 2>/dev/null' \
  '[ "$1" = 0 ] && exit 0' \
  'half=$(( $1 / 2 ))' \
  'ip link add ifb0 type ifb 2>/dev/null; ip link set ifb0 up' \
  'tc qdisc add dev eth0 root netem delay ${half}ms limit 100000' \
  'tc qdisc add dev eth0 ingress' \
  'tc filter add dev eth0 parent ffff: protocol all u32 match u32 0 0 action mirred egress redirect dev ifb0' \
  'tc qdisc add dev ifb0 root netem delay ${half}ms limit 100000' \
  > /usr/local/bin/netem && chmod +x /usr/local/bin/netem
# Entry: install the throwaway public key from $AUTHORIZED_KEY, then sshd.
RUN printf '%s\n' '#!/bin/sh' 'set -e' \
  'install -d -m 0700 -o werk -g werk /home/werk/.ssh' \
  'printf "%s\\n" "$AUTHORIZED_KEY" > /home/werk/.ssh/authorized_keys' \
  'chown werk:werk /home/werk/.ssh/authorized_keys; chmod 0600 /home/werk/.ssh/authorized_keys' \
  'exec /usr/sbin/sshd -D -e -o PasswordAuthentication=no' \
  > /entry.sh && chmod +x /entry.sh
EXPOSE 22
ENTRYPOINT ["/entry.sh"]
