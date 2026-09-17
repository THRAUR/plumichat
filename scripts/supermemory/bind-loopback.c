/*
 * bind-loopback — keep supermemory-server on this machine.
 *
 * The server hardcodes `hostname: "0.0.0.0"` (v0.0.8) and has no setting to
 * change it, so it would listen on every interface — the tailnet included.
 * Loaded with LD_PRELOAD, this rewrites a wildcard bind() on a TCP socket to
 * the matching loopback address. UDP is left alone on purpose: a resolver may
 * bind 0.0.0.0:0 before talking to the DNS server, and a loopback source
 * address cannot reach it.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <netinet/in.h>
#include <string.h>
#include <sys/socket.h>

static int is_tcp(int fd) {
  int type = 0; socklen_t n = sizeof type;
  return getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &n) == 0 && type == SOCK_STREAM;
}

int bind(int fd, const struct sockaddr *addr, socklen_t len) {
  static int (*real_bind)(int, const struct sockaddr *, socklen_t);
  if (!real_bind) real_bind = dlsym(RTLD_NEXT, "bind");
  if (addr && is_tcp(fd)) {
    if (addr->sa_family == AF_INET && len >= sizeof(struct sockaddr_in)) {
      struct sockaddr_in a; memcpy(&a, addr, sizeof a);
      if (a.sin_addr.s_addr == htonl(INADDR_ANY)) {
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        return real_bind(fd, (const struct sockaddr *)&a, sizeof a);
      }
    } else if (addr->sa_family == AF_INET6 && len >= sizeof(struct sockaddr_in6)) {
      struct sockaddr_in6 a; memcpy(&a, addr, sizeof a);
      if (!memcmp(&a.sin6_addr, &in6addr_any, sizeof a.sin6_addr)) {
        a.sin6_addr = in6addr_loopback;
        return real_bind(fd, (const struct sockaddr *)&a, sizeof a);
      }
    }
  }
  return real_bind(fd, addr, len);
}
