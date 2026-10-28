// On-chain spending policy as a circuit: approve a payment only if the vault is not frozen,
// the amount is within the limit, and the recipient slot is allow-listed.
module spend_policy(
  input  [7:0] amount,
  input  [7:0] limit,
  input  [3:0] allow_mask,
  input  [1:0] recipient,
  input        frozen,
  output       ok
);
  assign ok = !frozen && (amount <= limit) && allow_mask[recipient];
endmodule
