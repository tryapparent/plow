import Base

type Evidence is Data:
  Evidence{source: String, kind: String, id: String, thread: String, run: String, session: String,
    group: String, status: String, stamp: Nat, seen: Nat, revision: Nat, first: Nat, start: Nat, end: Nat,
    repository: String, attempt: String, sha: String, job: String}

type Span is Data:
  Span{first: Nat, last: Nat, category: String, operation: String, run: String}

type Thread is Data:
  Thread{id: String, spans: List<&2, Span>}

def valid(+a: Nat, b: Nat) -> Bool:
  Bool.and(Nat.is_lt(0n,a), Nat.is_lt(a,b))

def between(+span: Span, +from: Nat, +to: Nat, +tail: List<&2, Span>) -> List<&2, Span>:
  match span:
    case Span{a,b,category,operation,run}:
      +lo = Nat.max(a,from)
      +hi = Nat.min(b,to)
      Bool.pick(List<&2, Span>, valid(lo,hi), Span{lo,hi,category,operation,run} <> tail, tail)

def clip(items: List<&2, Span>, +from: Nat, +to: Nat) -> List<&2, Span>:
  match items:
    case []: []
    case head <> rest: between(head,from,to,clip(rest,from,to))

def span(+a: Nat, +b: Nat, category: String, operation: String, run: String, +tail: List<&2, Span>) -> List<&2, Span>:
  between(Span{a,b,category,operation,run},a,b,tail)

def earlier(a: Nat,b: Nat) -> Bool:
  Nat.is_lt(a,b)

def points(spans: List<&2, Span>, +tail: List<&2, Nat>) -> List<&2, Nat>:
  match spans:
    case []: tail
    case Span{a,b,_,_,_} <> rest: points(rest,a <> b <> tail)

def rank(category: String, operation: String) -> U32:
  match category:
    case "Provider": Bool.pick(U32,String.eq(operation,"Provider run"),4,5)
    case "T3 admission": 3
    case "Outside runs": Bool.pick(U32,String.eq(operation,"Missing clocks"),2,1)
    case _: 0

def active(spans: List<&2, Span>, +lo: Nat, +hi: Nat, best: Span, +priority: U32) -> Span:
  match spans best:
    case [] _: best
    case Span{a,b,+category,+name,+run} <> rest Span{_,_,+prior_category,+prior_name,+prior_run}:
      +covered = Bool.and(Nat.is_le(a,lo),Nat.is_le(hi,b))
      +score = rank(category,name)
      +higher = Bool.and(covered,U32.is_gt(score,priority))
      +tie = Bool.and(covered,U32.is_eq(score,priority))
      +label = Bool.pick(String,Bool.and(tie,Bool.not(String.eq(name,prior_name))),"Provider operations",name)
      +key = Bool.pick(String,Bool.and(tie,Bool.not(String.eq(run,prior_run))),"",run)
      +next = Bool.pick(Span,Bool.or(higher,tie),Span{lo,hi,category,label,key},
        Span{lo,hi,prior_category,prior_name,prior_run})
      active(rest,lo,hi,next,Bool.pick(U32,higher,score,priority))

def emit(tail: List<&2, Span>, part: Span) -> List<&2, Span>:
  match tail part:
    case [] Span{a,b,+kind,name,run}:
      Bool.pick(List<&2,Span>,String.is_empty(kind),[],[Span{a,b,kind,name,run}])
    case Span{+c,+d,+next_kind,+next_name,+next_run} <> +rest Span{+a,+b,+kind,+name,+run}:
      +same = Bool.and(Nat.is_eq(b,c),Bool.and(String.eq(kind,next_kind),
        Bool.and(String.eq(name,next_name),String.eq(run,next_run))))
      Bool.pick(List<&2, Span>,String.is_empty(kind),Span{c,d,next_kind,next_name,next_run} <> rest,
        Bool.pick(List<&2, Span>,same,Span{a,d,kind,name,run} <> rest,
          Span{a,b,kind,name,run} <> Span{c,d,next_kind,next_name,next_run} <> rest))

def divide(clocks: List<&2, Nat>, +spans: List<&2, Span>) -> List<&2, Span>:
  match clocks:
    case +a <> +b <> rest:
      +tail = divide(b <> rest,spans)
      Bool.pick(List<&2, Span>,Nat.is_lt(a,b),emit(tail,active(spans,a,b,Span{a,b,"","",""},0)),tail)
    case _: []

def disjoint(+spans: List<&2, Span>) -> List<&2, Span>:
  divide(List.sort(~Nat,~earlier,points(spans,[])),spans)

def first_clock(+a: Nat, +b: Nat, c: Nat) -> Nat:
  Bool.pick(Nat,Nat.is_gt(a,0n),a,Bool.pick(Nat,Nat.is_gt(b,0n),b,c))

def run_before(a: Evidence,b: Evidence) -> Bool:
  match a b:
    case Evidence{_,_,x,_,_,_,_,_,_,_,_,r,s,e,_,_,_,_} Evidence{_,_,y,_,_,_,_,_,_,_,_,u,v,w,_,_,_,_}:
      +lo = first_clock(r,s,e)
      +hi = first_clock(u,v,w)
      Bool.or(Nat.is_lt(lo,hi),Bool.and(Nat.is_eq(lo,hi),String.is_lt(x,y)))

def safe_operation(group: String) -> String:
  match group:
    case "command_execution": "Command execution"
    case "function_call": "Tool call"
    case _: ""

def operations(items: List<&2, Evidence>, +id: String, +link: String, +s: Nat, +e: Nat, +tail: List<&2, Span>) -> List<&2, Span>:
  match items:
    case []: tail
    case Evidence{_,_,_,_,run,_,group,_,_,_,_,_,+a,+b,_,_,_,_} <> rest:
      +name = safe_operation(group)
      +matches = Bool.and(String.eq(run,id),Bool.and(Bool.not(String.is_empty(name)),
        Bool.and(Nat.is_le(s,a),Nat.is_le(b,e))))
      +next = operations(rest,id,link,s,e,tail)
      Bool.pick(List<&2, Span>,matches,span(a,b,"Provider",name,link,next),next)

def from_runs(runs: List<&2, Evidence>, +ops: List<&2, Evidence>, +frontier: Nat, +completion: Nat) -> List<&2, Span>:
  match runs:
    case []: []
    case Evidence{_,_,_,_,+id,+session,_,_,_,_,_,+r,+s,+e,_,_,_,_} <> rest:
      +edge = first_clock(r,s,e)
      +last = Nat.max(r,Nat.max(s,e))
      +has_end = Nat.is_gt(e,0n)
      +measured = Bool.and(Nat.is_eq(frontier,completion),Nat.is_gt(r,0n))
      +label = Bool.pick(String,measured,"Between recorded runs","Missing clocks")
      +tail = from_runs(rest,ops,Nat.max(frontier,last),Bool.pick(Nat,has_end,Nat.max(completion,e),completion))
      +gap = span(frontier,edge,"Outside runs",label,"",tail)
      +unknown = Bool.pick(List<&2, Span>,Nat.is_eq(s,0n),span(r,e,"Outside runs","Missing clocks","",gap),gap)
      +admission = span(r,s,"T3 admission","Request to provider start","",unknown)
      +link = Bool.pick(String,String.is_empty(session),"",id)
      +provider = span(s,e,"Provider","Provider run",link,admission)
      Bool.pick(List<&2, Span>,valid(s,e),operations(ops,id,link,s,e,provider),provider)

def thread(+id: String, runs: List<&2, Evidence>, ops: List<&2, Evidence>, from: Nat, to: Nat) -> Thread:
  Thread{id, disjoint(clip(from_runs(List.sort(~Evidence,~run_before,runs),ops,0n,0n),from,to))}
