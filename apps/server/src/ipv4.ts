import { setDefaultResultOrder } from "node:dns";
import { setDefaultAutoSelectFamily, setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

/**
 * Some hosts advertise IPv6 and do not route it. `ipv4first` alone still lets
 * Happy Eyeballs dial that address and sit until the connect timeout, which is
 * longer than Render's 5s probe. Use the IPv4 answer and do not race IPv6.
 */
export function preferIpv4() {
  setDefaultResultOrder("ipv4first");
  setDefaultAutoSelectFamily(false);
  setDefaultAutoSelectFamilyAttemptTimeout(250);
}
