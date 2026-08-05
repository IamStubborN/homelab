FROM debian:13.6-slim@sha256:38a76d01668772e381ad2826d876627c89e7133e2f8a0f5d567306798b0f2a16

ENV DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates=20250419 \
        curl=8.14.1-2+deb13u4 \
        gnupg=2.4.7-21+deb13u1; \
    install -d -m 0755 /etc/apt/keyrings; \
    curl -fsSL https://swupdate.openvpn.net/repos/repo-public.gpg | gpg --dearmor --output /etc/apt/keyrings/openvpn-repo.gpg; \
    printf '%s\n' 'deb [arch=amd64 signed-by=/etc/apt/keyrings/openvpn-repo.gpg] https://build.openvpn.net/debian/openvpn/release/2.7 trixie main' > /etc/apt/sources.list.d/openvpn.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        bash=5.2.37-2+b9 \
        bind9-dnsutils=1:9.20.26-1~deb13u1 \
        dnsmasq=2.91-1+deb13u1 \
        iproute2=6.15.0-1 \
        iptables=1.8.11-2 \
        oathtool=2.6.12-1 \
        openvpn=2.7.5-trixie1 \
        tini=0.19.0-3+b7 \
        tzdata=2026b-0+deb13u1; \
    openvpn --version | sed -n '1p' | grep -Eq 'OpenVPN 2\.7\.[0-9]+([[:space:]-]|$)'; \
    printf '%s\n' '--- runtime versions ---'; \
    cat /etc/debian_version; \
    openvpn --version | sed -n '1p'; \
    oathtool --version | sed -n '1p'; \
    dnsmasq --version | sed -n '1p'; \
    bash --version | sed -n '1p'; \
    ip -V; \
    iptables --version; \
    dig -v 2>&1 | sed -n '1p'; \
    tini --version; \
    rm -rf /var/lib/apt/lists/*

COPY watcher.sh /usr/local/bin/pritunl-vpn-watcher
COPY openvpn-event-hook /usr/local/bin/pritunl-openvpn-hook

RUN chmod 0555 /usr/local/bin/pritunl-vpn-watcher /usr/local/bin/pritunl-openvpn-hook

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/pritunl-vpn-watcher"]
