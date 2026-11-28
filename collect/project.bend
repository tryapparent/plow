import Base
import 0x419ec39802735c4664960ab4b9d962e5/json.bend as Json
import 0xec25e4adfb02e59e4b817801115988ee/bytes.bend as Bytes

type RolloutStep is Data:
  Step{session: String, line: String}
  Rejected{}

def token_chars(text: String) -> Bool:
  match text:
    case SNil{}: True{}
    case SCon{head, tail}:
      +code = Char.to_u32(head)
      +digit = Bool.and(U32.is_ge(code, 48), U32.is_le(code, 57))
      +upper = Bool.and(U32.is_ge(code, 65), U32.is_le(code, 90))
      +lower = Bool.and(U32.is_ge(code, 97), U32.is_le(code, 122))
      +punctuation = Bool.or(U32.is_eq(code, 58), Bool.or(U32.is_eq(code, 45), U32.is_eq(code, 95)))
      Bool.and(Bool.or(Bool.or(digit, upper), Bool.or(lower, punctuation)), token_chars(tail))

def token(+text: String) -> Bool:
  +length = String.length(text)
  Bool.and(Bool.and(Nat.is_gt(length, 0n), Nat.is_le(length, 128n)), token_chars(text))

def text_field(key: String, value: String) -> Bytes.Bytes & Json.Val:
  (Json.utf8(key), Json.Str{Json.utf8(value)})

def clock_field(key: String, value: Nat) -> Bytes.Bytes & Json.Val:
  (Json.utf8(key), Json.Num{Json.utf8(Nat.show(value))})

def render(value: Json.Val) -> String:
  Bytes.to_string(Json.encode.bytes(value))

def positive_clock(parsed: Maybe<&2, Nat>) -> Maybe<&2, Nat>:
  match parsed:
    case None{}: None{}
    case Some{+ms}:
      Bool.pick(Maybe<&2, Nat>, Nat.is_gt(ms, 0n), Some{ms}, None{})

def clock(value: String) -> Maybe<&2, Nat>:
  positive_clock(Nat.read(value))

def render_run(id: String, thread: String, session: String, started: Maybe<&2, Nat>,
    completed: Maybe<&2, Nat>) -> String:
  match started completed:
    case Some{+start} Some{+end}:
      Bool.pick(String, Nat.is_le(start, end), render(Json.Obj{[text_field("kind", "t3_run"),
        (Json.utf8("run"), Json.Obj{[text_field("id", id), text_field("threadId", thread),
          text_field("sessionId", session), clock_field("startedMs", start), clock_field("completedMs", end)]})]}), "")
    case _ _: ""

def run(+id: String, +thread: String, +session: String, started: String, completed: String) -> String:
  Bool.pick(String, Bool.and(token(id), Bool.and(token(thread), token(session))),
    render_run(id, thread, session, clock(started), clock(completed)), "")

def render_event(kind: String, +session: String, call: String, timestamp: Maybe<&2, Nat>, ordinal: U32) -> String:
  match timestamp:
    case Some{ms}:
      +id = String.append(session, String.append(":", Nat.show(U32.to_nat(ordinal))))
      render(Json.Obj{[text_field("kind", kind), text_field("eventId", id), text_field("sessionId", session),
        text_field("callId", call), clock_field("timestampMs", ms)]})
    case None{}: ""

def event(kind: String, +session: String, +call: String, timestamp: String, ordinal: U32) -> String:
  Bool.pick(String, Bool.and(token(call), Bool.not(String.is_empty(session))),
    render_event(kind, session, call, clock(timestamp), ordinal), "")

def rollout(+session: String, envelope: String, kind: String, +metadata_id: String, call_id: String,
    timestamp: String, ordinal: U32) -> RolloutStep:
  match envelope:
    case "session_meta":
      Bool.pick(RolloutStep, Bool.and(token(metadata_id), Bool.or(String.is_empty(session), String.eq(session, metadata_id))),
        Step{metadata_id, ""}, Rejected{})
    case "response_item":
      match kind:
        case "function_call": Step{session, event("function_call", session, call_id, timestamp, ordinal)}
        case "function_call_output": Step{session, event("function_call_output", session, call_id, timestamp, ordinal)}
        case _: Step{session, ""}
    case _: Step{session, ""}

type T3Binding is Data:
  T3Binding{owner: String, driver: String, native_driver: String, strength: String, session: String, reference: String}

type T3Run is Data:
  T3Run{owner: String, id: String, started: String, completed: String}

type Choice is Data:
  Missing{}
  Exact{value: String}
  Ambiguous{}

def select(matches: Bool, found: Choice, value: String) -> Choice:
  match matches found:
    case False{} unchanged: unchanged
    case True{} Missing{}: Exact{value}
    case True{} _: Ambiguous{}

def binding(+thread: String, refs: List<&2, T3Binding>, found: Choice) -> Choice:
  match refs:
    case []: found
    case T3Binding{owner, driver, native_driver, strength, +session, _} <> rest:
      +matches = Bool.and(String.eq(owner, thread), Bool.and(String.eq(driver, "codex"),
        Bool.and(String.eq(native_driver, "codex"), Bool.and(String.eq(strength, "strong"), token(session)))))
      binding(thread, rest, select(matches, found, session))

def scoped_run(+thread: String, +wanted: String, +session: String, runs: List<&2, T3Run>, found: Choice) -> Choice:
  match runs:
    case []: found
    case T3Run{owner, +id, started, completed} <> rest:
      +matches = Bool.and(String.eq(owner, thread), String.eq(id, wanted))
      +line = run(id, thread, session, started, completed)
      scoped_run(thread, wanted, session, rest, select(matches, found, line))

def chosen_run(choice: Choice) -> String:
  match choice:
    case Exact{value}: value
    case _: ""

def apply_binding(choice: Choice, thread: String, wanted: String, runs: List<&2, T3Run>) -> String:
  match choice:
    case Exact{session}: chosen_run(scoped_run(thread, wanted, session, runs, Missing{}))
    case _: ""

def t3_run(+thread: String, wanted: String, refs: List<&2, T3Binding>, runs: List<&2, T3Run>) -> String:
  apply_binding(binding(thread, refs, Missing{}), thread, wanted, runs)
