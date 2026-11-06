export type Fate = "admitted" | "rejected" | "pending" | "evicted" | "included-success" | "included-revert" | "replaced";

export interface ActorSpec {
  role: string;
  /** Funded from the public funder in the setup group; decimal wei. */
  fund_wei?: string;
}

export interface Limits {
  checkpoint_wait_ms: number;
  scenario_ms: number;
  shrink_candidates: number;
  shrink_wall_ms: number;
}

interface StepBase {
  id: string;
  /** Steps in the same group are deleted together by the reducer. */
  group?: string;
  depends_on?: string[];
}

export interface FundStep extends StepBase {
  action: "fund";
  actors: string[];
}

export interface SubmitStep extends StepBase {
  action: "submit";
  tx_role: string;
  actor: string;
  /** EIP-8250 nonce key (decimal); "0" means the linear account nonce. */
  nonce_key: string;
  value_wei?: string;
  to?: string;
}

export type Amount = { wei: string } | { leave_max_cost_multiple: number; of_tx_role: string };

export interface TransferStep extends StepBase {
  action: "transfer";
  actor: string;
  to: string;
  amount: Amount;
}

export interface CheckpointStep extends StepBase {
  action: "advance-to-checkpoint";
  checkpoint_id: string;
}

export type Step = FundStep | SubmitStep | TransferStep | CheckpointStep;

export type Precondition =
  | { kind: "admitted"; tx_role: string }
  | { kind: "obligations-exceed-balance"; account: string }
  | { kind: "in-newest-cancellation-set"; tx_role: string; account: string }
  | { kind: "outside-newest-cancellation-set"; tx_role: string; account: string }
  | { kind: "no-obligation-to"; tx_role: string; account: string };

export interface Expectation {
  assertion_id: string;
  tx_role: string;
  checkpoint_id: string;
  expected: Fate;
  rule_ref: string;
  derivation: string;
  preconditions: Precondition[];
  evidence_required: string[];
  required?: boolean;
}

export interface ScenarioV1 {
  schema: "framelab.scenario/v1";
  id: string;
  description: string;
  seed: string;
  rule_pack: string;
  protocol_revisions: Record<string, string>;
  genesis: { sha256: string; chain_id: number };
  actors: ActorSpec[];
  steps: Step[];
  expectations: Expectation[];
  limits: Limits;
}
