import Base
import 0x29d6f1ff259add9ea6c8f213fda12377/sha256.bend as Sha
import ./project.bend as P
import 0x419ec39802735c4664960ab4b9d962e5/json.bend as J
import 0xec25e4adfb02e59e4b817801115988ee/bytes.bend as Bytes

def ms(value: Nat) -> Bytes.Bytes & J.Val:
  P.clock_field("timestampMs",value)

def str(key: String,value: String) -> Bytes.Bytes & J.Val:
  P.text_field(key,value)

def num(key: String,+value: Nat) -> Bytes.Bytes & J.Val:
  (J.utf8(key),Bool.pick(J.Val,Nat.is_gt(value,0n),J.Num{J.utf8(Nat.show(value))},J.Null{}))

def or_zero(parsed: Maybe<&2,Nat>) -> Nat:
  match parsed:
    case Some{at}: at
    case None{}: 0n

def value(clock: String) -> Nat:
  or_zero(P.clock(clock))

def fresh_identity(scope: String, id: String) -> String:
  String.concat([scope,":",id])

def hex_digit(ch: Char) -> Bool:
  +code = Char.to_u32(ch)
  Bool.or(Bool.and(U32.is_ge(code,48),U32.is_le(code,57)),
    Bool.or(Bool.and(U32.is_ge(code,65),U32.is_le(code,70)),Bool.and(U32.is_ge(code,97),U32.is_le(code,102))))

def stock_chars(input: String) -> Bool:
  match input:
    case SNil{}: True{}
    case SCon{'%',SCon{a,SCon{b,tail}}}: Bool.and(Bool.and(hex_digit(a),hex_digit(b)),stock_chars(tail))
    case SCon{ch,tail}: Bool.and(P.token_chars(SCon{ch,SNil{}}),stock_chars(tail))

def stock_id(+input: String) -> Bool:
  Bool.and(Bool.and(Nat.is_gt(String.length(input),0n),Nat.is_le(String.length(input),512n)),stock_chars(input))

def run_status(status: String) -> String:
  match status:
    case "idle": "idle"
    case "preparing": "preparing"
    case "queued": "queued"
    case "starting": "starting"
    case "waiting": "waiting"
    case "rolled_back": "rolled_back"
    case "pending": "pending"
    case "running": "running"
    case "completed": "completed"
    case "failed": "failed"
    case "cancelled": "cancelled"
    case "interrupted": "interrupted"
    case _: "unknown"

def exact_session(choice: P.Choice) -> String:
  match choice:
    case P.Exact{session}: session
    case _: ""

def run_binding(+thread: String,+provider: String,refs: List<&2,P.T3Binding>,prior: P.Choice) -> P.Choice:
  match refs:
    case []: prior
    case P.T3Binding{owner,driver,native,strength,+session,reference} <> rest:
      +id = Bool.and(Bool.not(String.is_empty(provider)),String.eq(provider,reference))
      +kind = Bool.and(String.eq(driver,"codex"),Bool.and(String.eq(native,"codex"),String.eq(strength,"strong")))
      +matches = Bool.and(Bool.and(id,kind),Bool.and(String.eq(owner,thread),P.token(session)))
      run_binding(thread,provider,rest,P.select(matches,prior,session))

def run(+scope: String,+thread: String,+id: String,owner: String,status: String,requested: String,
    started: String,completed: String,updated: String,observed: String,provider: String,refs: List<&2,P.T3Binding>) -> String:
  +r = value(requested)
  +s = value(started)
  +e = value(completed)
  +rev = value(updated)
  +seen = value(observed)
  +at = Nat.max(r,Nat.max(s,e))
  +session = exact_session(run_binding(thread,provider,refs,P.Missing{}))
  +valid = Bool.and(Bool.and(P.token(scope),stock_id(thread)),Bool.and(stock_id(id),String.eq(thread,owner)))
  +key = fresh_identity(scope,id)
  row : J.Val = J.Obj{[str("kind","t3_activity_run"),str("eventId",key),
    ms(Bool.pick(Nat,Nat.is_gt(at,0n),at,Nat.max(1n,rev))),num("revisionMs",rev),num("observedMs",seen),
    str("threadKey",fresh_identity(scope,thread)),
    (J.utf8("run"),J.Obj{[str("id",id),str("threadId",thread),str("sessionId",session),
      str("status",run_status(status)),num("requestedMs",r),num("startedMs",s),num("completedMs",e)]})]}
  Bool.pick(String,valid,P.render(row),"")

def operation(+scope: String,+thread: String,+id: String,owner: String,visibility: String,+run: String,kind: String,
    driver: String,strength: String,started: String,completed: String,updated: String,observed: String) -> String:
  +a = value(started)
  +b = value(completed)
  +rev = value(updated)
  +seen = value(observed)
  +strong = Bool.and(String.eq(driver,"codex"),String.eq(strength,"strong"))
  +local = Bool.and(String.eq(thread,owner),String.eq(visibility,"local"))
  +valid = Bool.and(Bool.and(P.token(scope),stock_id(thread)),Bool.and(stock_id(id),stock_id(run)))
  +eligible = Bool.and(Bool.and(strong,local),Bool.and(valid,String.eq(kind,"command_execution")))
  +at = Nat.max(a,b)
  row : J.Val = J.Obj{[str("kind","operation"),str("eventId",fresh_identity(scope,id)),str("threadId",fresh_identity(scope,thread)),
    str("t3RunId",run),str("operation","command_execution"),ms(Bool.pick(Nat,Nat.is_gt(at,0n),at,Nat.max(1n,rev))),
    num("revisionMs",rev),num("observedMs",seen),num("startedMs",a),num("completedMs",b)]}
  Bool.pick(String,eligible,P.render(row),"")

def page(+previous: String,+next: String,more: Bool) -> Bool:
  +valid = Bool.and(Bool.not(String.is_empty(next)),Bool.not(String.eq(previous,next)))
  Bool.pick(Bool,more,valid,String.is_empty(next))

def status(input: String) -> String:
  match input:
    case "working": "working"
    case "idle": "idle"
    case "retrying": "retrying"
    case "blocked": "blocked"
    case "complete": "complete"
    case _: "blocked"

def gap(input: String) -> String:
  match input:
    case "access": "access"
    case "source_unavailable": "source_unavailable"
    case "bounded_inventory": "bounded_inventory"
    case "incomplete_projection": "incomplete_projection"
    case "checkpoint_io": "checkpoint_io"
    case "unsupported_archive": "unsupported_archive"
    case "record_limit": "record_limit"
    case _: ""

def numeric(key: String,parsed: Maybe<&2,Nat>) -> Bytes.Bytes & J.Val:
  match parsed:
    case None{}: (J.utf8(key),J.Null{})
    case Some{at}: P.clock_field(key,at)

def measure(key: String,value: String) -> Bytes.Bytes & J.Val:
  numeric(key,Nat.read(value))

def health(collector: String,+scope: String,lane: String,state: String,observed: String,last: String,newest: String,
    oldest: String,scanned: String,eligible: String,written: String,unit: String,reason: String) -> String:
  row : J.Val = J.Obj{[str("kind","collector_health"),P.clock_field("schemaVersion",1n),str("collector",collector),
    str("scope",scope),str("lane",lane),str("status",status(state)),num("observedMs",value(observed)),
    measure("lastSuccessMs",last),measure("newestSourceMs",newest),measure("oldestScannedMs",oldest),
    measure("scannedUnits",scanned),measure("eligibleUnits",eligible),measure("ingestedRecords",written),
    str("unit",unit),str("gapCode",gap(reason))]}
  Bool.pick(String,P.token(scope),P.render(row),"")

def coverage(+scope: String, collector: String, lane: String, state: String, +observed: String, oldest: String, cutoff: String) -> String:
  +at = value(observed)
  +id = String.concat([scope,":",lane,":",observed])
  row : J.Val = J.Obj{[str("kind",collector),str("eventId",id),str("status",status(state)),
    ms(at),num("observedMs",at),num("oldestSourceMs",value(oldest)),num("cutoffMs",value(cutoff))]}
  Bool.pick(String,P.token(scope),P.render(row),"")

def codex_kind(kind: String) -> String:
  match kind:
    case "function_call": "function_call"
    case "function_call_output": "function_call_output"
    case "custom_tool_call": "function_call"
    case "custom_tool_call_output": "function_call_output"
    case _: ""

def codex(wire_kind: String,+session: String,+call: String,clock: String) -> String:
  +kind = codex_kind(wire_kind)
  +at = value(clock)
  +key = String.concat([session,":",call,":",kind,":",Nat.show(at)])
  +valid = Bool.and(P.token(session),Bool.and(P.token(call),Nat.is_gt(at,0n)))
  +type_valid = Bool.or(String.eq(kind,"function_call"),String.eq(kind,"function_call_output"))
  row : J.Val = J.Obj{[str("kind",kind),str("eventId",String.append("codex:",Sha.hex_of_text(key))),str("sessionId",session),str("callId",call),ms(at)]}
  Bool.pick(String,Bool.and(valid,type_valid),P.render(row),"")

type Target is Data:
  Target{id: String, updated: Nat}

def newer(a: Target,b: Target) -> Bool:
  match a b:
    case Target{x,+u} Target{y,+v}:
      Bool.or(Nat.is_gt(u,v),Bool.and(Nat.is_eq(u,v),String.is_lt(x,y)))

def inventory(items: List<&2,Target>) -> List<&2,Target>:
  List.sort(~Target,~newer,items)

def repo_chars(input: String) -> Bool:
  match input:
    case SNil{}: True{}
    case SCon{+ch,tail}:
      +code = Char.to_u32(ch)
      +valid = Bool.or(U32.is_eq(code,47),Bool.or(U32.is_eq(code,46),P.token_chars(SCon{ch,SNil{}})))
      Bool.and(valid,repo_chars(tail))

def pr_link(+scope: String,+thread: String,host: String,+repo: String,+number: String,+origin: String,
    revision: String,observed: String) -> String:
  +owned = Bool.or(String.eq(origin,"created"),String.eq(origin,"agent"))
  +valid = Bool.and(Bool.and(P.token(scope),stock_id(thread)),Bool.and(owned,String.eq(host,"github.com")))
  +at = value(revision)
  +key = String.concat([scope,":",thread,":",repo,":",number])
  row : J.Val = J.Obj{[str("kind","t3_pr_link"),str("eventId",key),str("threadId",fresh_identity(scope,thread)),
    str("repository",String.to_lower(repo)),str("prNumber",number),ms(at),num("revisionMs",at),num("observedMs",value(observed))]}
  Bool.pick(String,Bool.and(valid,Bool.and(repo_chars(repo),Bool.and(Nat.is_gt(value(number),0n),Nat.is_gt(at,0n)))),P.render(row),"")

def poll_priority(updated: Nat, +retry: Nat, +now: Nat) -> Nat:
  Bool.pick(Nat,Nat.is_gt(retry,0n),Nat.sub(now,retry),Nat.add(now,updated))
