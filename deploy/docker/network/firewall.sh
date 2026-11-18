#!/bin/sh
set -eu
# Rules apply only inside this stack's network namespace.
iptables -P OUTPUT DROP
iptables -F OUTPUT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
search_ip=$(getent ahostsv4 searxng | awk 'NR==1 {print $1}')
[ -n "$search_ip" ]
iptables -A OUTPUT -d "$search_ip" -p tcp --dport 8080 -j ACCEPT
runner_ip=$(getent ahostsv4 execution-broker | awk 'NR==1 {print $1}')
[ -n "$runner_ip" ]
iptables -A OUTPUT -d "$runner_ip" -p tcp --dport 8080 -j ACCEPT
for range in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4; do
 iptables -A OUTPUT -d "$range" -j REJECT
done
iptables -A OUTPUT -p tcp -m multiport --dports 80,443 -j ACCEPT
# No IPv6 escape path; public research/provider traffic uses IPv4.
ip6tables -P OUTPUT DROP
ip6tables -F OUTPUT
ip6tables -A OUTPUT -o lo -j ACCEPT
ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
touch /run/ready
exec sleep infinity
