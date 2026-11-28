import Base
import ./activity-spans.bend as S
import ./activity-report.bend as R
import ./activity-ci.bend as CI

type Receipt is Data:
  Missing{}
  Current{record: S.Evidence}
  Conflict{revision: Nat}

type Batch is Data:
  Batch{id: String, runs: List<&2, S.Evidence>, ops: List<&2, S.Evidence>}

type RunLink is Data:
  RunLink{thread: String, run: String, source: String, first: Nat, last: Nat}

type Activity is Data:
  Activity{from: Nat, cutoff: Nat, oldest: Nat, t3Coverage: String, codexCoverage: String,
    ciCoverage: String, outcomeCoverage: String, unknownRuns: Nat, conflicts: Nat,
    threads: List<&2, S.Thread>, links: List<&2, RunLink>, ci: List<&2, S.Thread>, totals: List<&2, R.Totals>, categories: List<&2, R.Totals>,
    buckets: List<&2, R.Bucket>, findings: List<&2, R.Issue>}

def key(+left: String,right: String) -> String:
  String.concat([Nat.show(String.length(left)),":",left,right])

def signature(item: S.Evidence) -> String:
  match item:
    case S.Evidence{source,kind,id,thread,run,session,group,status,stamp,_,revision,a,b,c,repo,attempt,sha,job}:
      String.concat([key(source,kind),key(id,thread),key(run,session),key(group,status),key(Nat.show(stamp),Nat.show(revision)),
        key(Nat.show(a),Nat.show(b)),key(Nat.show(c),repo),key(attempt,sha),job])

def resolve(prior: Receipt, +record: S.Evidence, +revision: Nat) -> Receipt:
  match prior:
    case Missing{}: Current{record}
    case Conflict{+at}: Bool.pick(Receipt,Nat.is_lt(at,revision),Current{record},Conflict{at})
    case Current{+previous}:
      match previous:
        case S.Evidence{_,_,_,_,_,_,_,_,_,_,+at,_,_,_,_,_,_,_}:
          Bool.pick(Receipt,Nat.is_lt(at,revision),Current{record},
            Bool.pick(Receipt,Bool.or(Nat.is_lt(revision,at),String.eq(signature(previous),signature(record))),Current{previous},Conflict{revision}))

def update(entry: Map<&2, Receipt> & Receipt, id: String, record: S.Evidence, revision: Nat) -> Map<&2, Receipt>:
  match entry:
    case (table, prior): Map.set(&2,Receipt,table,id,resolve(prior,record,revision))

def entity(item: S.Evidence) -> String:
  match item:
    case S.Evidence{source,+kind,id,_,run,_,_,_,_,_,_,_,_,_,repo,attempt,_,job}:
      +action = Bool.or(String.eq(kind,"github_actions_job"),String.eq(kind,"github_actions_attempt"))
      key(source,key(kind,Bool.pick(String,action,key(repo,key(run,key(attempt,job))),id)))

def index(items: List<&2, S.Evidence>, +limit: Nat, +table: Map<&2, Receipt>) -> Map<&2, Receipt>:
  match items:
    case []: table
    case +item <> rest:
      match item:
        case S.Evidence{source,+kind,+id,_,_,_,_,_,stamp,seen,revision,_,_,_,_,_,_,_}:
          +identity = entity(item)
          +valid = Bool.and(Bool.not(Bool.or(String.is_empty(id),String.is_empty(kind))),
            Bool.and(Nat.is_le(stamp,limit),Nat.is_le(seen,limit)))
          index(rest,limit,Bool.pick(Map<&2,Receipt>,valid,
            update(Map.get(Receipt,Missing{},table,identity),identity,item,revision),table))

type Indexed is Data:
  Indexed{rows: List<&2, S.Evidence>, conflicts: Nat}

def selected(items: List<&2, Receipt>, +rows: List<&2, S.Evidence>, +conflicts: Nat) -> Indexed:
  match items:
    case []: Indexed{rows,conflicts}
    case Current{row} <> rest: selected(rest,row <> rows,conflicts)
    case Conflict{_} <> rest: selected(rest,rows,Nat.add(conflicts,1n))
    case Missing{} <> rest: selected(rest,rows,conflicts)

def classifiers(rows: List<&2, S.Evidence>, +kind: String) -> List<&2, S.Evidence>:
  match rows:
    case []: []
    case +row <> rest:
      match row:
        case S.Evidence{_,label,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_}:
          +tail = classifiers(rest,kind)
          Bool.pick(List<&2,S.Evidence>,String.eq(label,kind),row <> tail,tail)

def collect(entry: Map<&2, Batch> & Batch, +id: String, kind: String, +item: S.Evidence) -> Map<&2, Batch>:
  match entry:
    case (table, Batch{_,+runs,+ops}):
      +value = Bool.pick(Batch,String.eq(kind,"run"),Batch{id,item <> runs,ops},Batch{id,runs,item <> ops})
      Map.set(&2,Batch,table,id,value)

def batches(rows: List<&2, S.Evidence>, +table: Map<&2, Batch>) -> Map<&2, Batch>:
  match rows:
    case []: table
    case +row <> rest:
      match row:
        case S.Evidence{_,+kind,_,+id,_,_,_,_,_,_,_,_,_,_,_,_,_,_}:
          +valid = Bool.and(Bool.not(String.is_empty(id)),Bool.or(String.eq(kind,"run"),String.eq(kind,"operation")))
          batches(rest,Bool.pick(Map<&2,Batch>,valid,
            collect(Map.get(Batch,Batch{id,[],[]},table,id),id,kind,row),table))

def add_thread(row: S.Thread, tail: List<&2, S.Thread>) -> List<&2, S.Thread>:
  match row:
    case S.Thread{_,[]}: tail
    case _: row <> tail

def prepare(groups: List<&2, Batch>, +lo: Nat, +hi: Nat) -> List<&2, S.Thread>:
  match groups:
    case []: []
    case Batch{id,runs,ops} <> rest:
      add_thread(S.thread(id,runs,ops,lo,hi),prepare(rest,lo,hi))

def thread_before(a: S.Thread,b: S.Thread) -> Bool:
  match a b:
    case S.Thread{x,_} S.Thread{y,_}: String.is_lt(x,y)

type Watermark is Data:
  Watermark{observed: Nat, cutoff: Nat, oldest: Nat, status: String}

def watermark(rows: List<&2, S.Evidence>, +kind: String, current: Watermark) -> Watermark:
  match rows current:
    case [] _: current
    case S.Evidence{_,name,_,_,_,_,_,status,+at,_,_,oldest,cutoff,_,_,_,_,_} <> rest Watermark{+observed,prior_cutoff,prior_oldest,prior_status}:
      +newer = Bool.and(String.eq(name,kind),Nat.is_gt(at,observed))
      watermark(rest,kind,Bool.pick(Watermark,newer,Watermark{at,cutoff,oldest,status},Watermark{observed,prior_cutoff,prior_oldest,prior_status}))

def clock_gaps(runs: List<&2, S.Evidence>, +lo: Nat, +hi: Nat) -> Nat:
  match runs:
    case []: 0n
    case S.Evidence{_,_,_,_,_,_,_,_,stamp,_,_,r,+s,e,_,_,_,_} <> rest:
      +unknown = Bool.or(Bool.not(S.valid(r,s)),Bool.not(S.valid(s,e)))
      +in_window = R.inside(stamp,lo,hi)
      Nat.add(Bool.pick(Nat,Bool.and(unknown,in_window),1n,0n),clock_gaps(rest,lo,hi))

def matches(spans: List<&2,S.Span>, +operation: String) -> Bool:
  match spans:
    case []: False{}
    case S.Span{_,_,category,name,_} <> rest:
      Bool.or(Bool.or(String.eq(operation,category),String.eq(operation,name)),matches(rest,operation))

def filter(threads: List<&2,S.Thread>, +operation: String) -> List<&2,S.Thread>:
  match threads:
    case []: []
    case +lane <> rest:
      match lane:
        case S.Thread{_,spans}:
          +keep = Bool.or(String.eq(operation,"all"),Bool.or(String.is_empty(operation),matches(spans,operation)))
          +tail = filter(rest,operation)
          Bool.pick(List<&2,S.Thread>,keep,lane <> tail,tail)

def run_links(rows: List<&2,S.Evidence>, +from: Nat,+to: Nat) -> List<&2,RunLink>:
  match rows:
    case []: []
    case S.Evidence{source,_,id,thread,run,session,_,_,_,_,_,_,+start,+end,_,_,_,_} <> rest:
      +tail = run_links(rest,from,to)
      +known = Bool.and(Bool.not(String.is_empty(session)),Bool.and(S.valid(start,end),
        Bool.and(Nat.is_lt(start,to),Nat.is_lt(from,end))))
      Bool.pick(List<&2,RunLink>,known,RunLink{thread,run,source,start,end} <> tail,tail)

def lookup_selected(result: Indexed) -> List<&2,S.Evidence>:
  match result:
    case Indexed{rows,0n}: classifiers(rows,"run")
    case _: []

def lookup(rows: List<&2,S.Evidence>, +limit: Nat) -> List<&2,S.Evidence>:
  lookup_selected(selected(Map.values(&2,Receipt,index(rows,limit,Map.new(&2,Receipt))),[],0n))

def coverage_status(mark: Watermark) -> String:
  match mark:
    case Watermark{_,_,_,status}: status

def report(mark: Watermark, +rows: List<&2, S.Evidence>, conflicts: Nat, +range: String, +to: Nat, partial: Bool, operation: String) -> Activity:
  match mark:
    case Watermark{_,+cutoff,oldest,status}:
      +days = String.eq(range,"7d")
      +step = Bool.pick(Nat,days,86400000n,14400000n)
      +count = Bool.pick(Nat,days,7n,6n)
      +end = Bool.pick(Nat,Nat.is_gt(cutoff,0n),cutoff,to)
      +start = Nat.sub(end,Nat.mul(step,count))
      +runs = classifiers(rows,"run")
      +threads = List.sort(~S.Thread,~thread_before,prepare(Map.values(&2,Batch,batches(rows,Map.new(&2,Batch))),start,end))
      +coverage = Bool.pick(String,partial,"Partial Loki read",status)
      +attempts = classifiers(rows,"github_actions_attempt")
      +ci = CI.join(List.concat(&2,S.Evidence,[attempts,classifiers(rows,"github_actions_job")]),
        List.concat(&2,S.Evidence,[classifiers(rows,"t3_ci_link"),classifiers(rows,"t3_pr_link")]),attempts)
      +lanes = List.sort(~S.Thread,~thread_before,CI.timeline(ci,start,end))
      +ci_status = Bool.pick(String,Nat.is_eq(List.length(&2,S.Thread,lanes),0n),
        "No linked CI clocks in range","Exact linkage only. Other CI coverage is unknown")
      +confirmed = classifiers(rows,"confirmed_delay")
      +codex = coverage_status(watermark(rows,"codex_coverage",Watermark{0n,0n,0n,"No Codex collection checkpoint"}))
      +totals = R.breakdown(threads)
      Activity{start,cutoff,oldest,coverage,codex,
        ci_status,"No confirmed outcome feed checkpoint",clock_gaps(runs,start,end),conflicts,
        filter(threads,operation),run_links(runs,start,end),lanes,totals,R.categories(totals),R.series(count,threads,start,step),
        R.rank(List.concat(&2,S.Evidence,[runs,ci,confirmed]),start,end)}

def analyzed(indexed: Indexed, range: String, to: Nat, partial: Bool, operation: String) -> Activity:
  match indexed:
    case Indexed{+rows,conflicts}:
      report(watermark(rows,"t3_coverage",Watermark{0n,0n,0n,"No T3 capture checkpoint"}),rows,conflicts,range,to,partial,operation)

def activity(records: List<&2, S.Evidence>, range: String, +to: Nat, partial: Bool, operation: String) -> Activity:
  analyzed(selected(Map.values(&2,Receipt,index(records,to,Map.new(&2,Receipt))),[],0n),range,to,partial,operation)
