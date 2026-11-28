import Base
import ./activity-spans.bend as S

type Totals is Data:
  Totals{category: String, operation: String, ms: Nat}

type Bucket is Data:
  Bucket{time: Nat, threads: Nat, share: Maybe<&2, Nat>}

type Issue is Data:
  Issue{kind: String, occurrences: Nat, measured: Nat, ms: Maybe<&2, Nat>, next: String}

type Score is Data:
  Score{work: Nat, admission: Nat}

type Priority is Data:
  Priority{kind: String, occurrences: Nat, measured: Nat, ms: Nat, next: String}

def sum(entry: Map<&2, Totals> & Totals, key: String, duration: Nat) -> Map<&2, Totals>:
  match entry:
    case (table, Totals{category,operation,ms}):
      Map.set(&2,Totals,table,key,Totals{category,operation,Nat.add(duration,ms)})

def tally(spans: List<&2, S.Span>, table: Map<&2, Totals>) -> Map<&2, Totals>:
  match spans:
    case []: table
    case S.Span{a,b,+category,+name,_} <> rest:
      +key = String.append(category,String.append("/",name))
      tally(rest,sum(Map.get(Totals,Totals{category,name,0n},table,key),key,Nat.sub(b,a)))

def tally_threads(threads: List<&2, S.Thread>, table: Map<&2, Totals>) -> Map<&2, Totals>:
  match threads:
    case []: table
    case S.Thread{_,spans} <> rest: tally_threads(rest,tally(spans,table))

def by_time(a: Totals,b: Totals) -> Bool:
  match a b:
    case Totals{c,n,+x} Totals{d,m,+y}:
      +key = String.append(c,n)
      +other = String.append(d,m)
      Bool.or(Nat.is_gt(x,y),Bool.and(Nat.is_eq(x,y),String.is_lt(key,other)))

def breakdown(threads: List<&2, S.Thread>) -> List<&2, Totals>:
  List.sort(~Totals,~by_time,Map.values(&2,Totals,tally_threads(threads,Map.new(&2,Totals))))

def category_totals(items: List<&2,Totals>, table: Map<&2,Totals>) -> Map<&2,Totals>:
  match items:
    case []: table
    case Totals{+category,_,ms} <> rest:
      category_totals(rest,sum(Map.get(Totals,Totals{category,"",0n},table,category),category,ms))

def categories(items: List<&2,Totals>) -> List<&2,Totals>:
  List.sort(~Totals,~by_time,Map.values(&2,Totals,category_totals(items,Map.new(&2,Totals))))

def score(spans: List<&2, S.Span>, current: Score) -> Score:
  match spans current:
    case [] _: current
    case S.Span{a,b,+kind,_,_} <> rest Score{work,admission}:
      +ms = Nat.sub(b,a)
      score(rest,Score{Nat.add(work,Bool.pick(Nat,String.eq(kind,"Provider"),ms,0n)),
        Nat.add(admission,Bool.pick(Nat,String.eq(kind,"T3 admission"),ms,0n))})

type Mean is Data:
  Mean{count: Nat, points: Nat}

def next_share(result: Score, +count: Nat, +total: Nat) -> Mean:
  match result:
    case Score{+work,admission}:
      +classified = Nat.add(work,admission)
      +measured = Nat.is_gt(classified,0n)
      +part = Nat.div(Nat.mul(work,1000000n),Nat.max(1n,classified))
      Mean{Nat.add(count,Bool.pick(Nat,measured,1n,0n)),Nat.add(total,part)}

def shares(threads: List<&2, S.Thread>, +from: Nat, +to: Nat, total: Mean) -> Bucket:
  match threads total:
    case [] Mean{+count,points}:
      +basis = Nat.div(Nat.add(points,Nat.mul(count,50n)),Nat.mul(Nat.max(1n,count),100n))
      Bucket{from,count,Bool.pick(Maybe<&2,Nat>,Nat.is_eq(count,0n),None{},Some{basis})}
    case S.Thread{_,spans} <> rest Mean{count,points}:
      shares(rest,from,to,next_share(score(S.clip(spans,from,to),Score{0n,0n}),count,points))

def series(buckets: Nat, +threads: List<&2, S.Thread>, +from: Nat, +step: Nat) -> List<&2, Bucket>:
  match buckets:
    case 0n: []
    case 1n+rest:
      +to = Nat.add(from,step)
      shares(threads,from,to,Mean{0n,0n}) <> series(rest,threads,to,step)

def add(current: Priority, +start: Nat, +end: Nat) -> Priority:
  match current:
    case Priority{kind,occurrences,measured,ms,next}:
      +known = S.valid(start,end)
      Priority{kind,Nat.add(occurrences,1n),Nat.add(measured,Bool.pick(Nat,known,1n,0n)),
        Nat.add(ms,Bool.pick(Nat,known,Nat.sub(end,start),0n)),next}

def inside(+stamp: Nat, from: Nat, to: Nat) -> Bool:
  Bool.and(Nat.is_le(from,stamp),Nat.is_lt(stamp,to))

def priorities(records: List<&2, S.Evidence>, +from: Nat, +to: Nat, +admission: Priority, +ci: Priority, +delay: Priority) -> List<&2, Priority>:
  match records:
    case []: [delay,admission,ci]
    case S.Evidence{_,+kind,_,_,_,_,_,+status,stamp,_,_,+request,+start,+end,_,_,_,_} <> rest:
      +a = Nat.max(request,from)
      +b = Nat.min(start,to)
      +wait = Bool.and(Nat.is_gt(request,0n),Bool.or(S.valid(a,b),Bool.and(Nat.is_eq(start,0n),inside(request,from,to))))
      +failure = Bool.or(String.eq(status,"failure"),String.eq(status,"timed_out"))
      +count_wait = Bool.and(String.eq(kind,"run"),wait)
      +count_ci = Bool.and(String.eq(kind,"github_actions_job"),Bool.and(inside(stamp,from,to),failure))
      +count_delay = Bool.and(String.eq(kind,"confirmed_delay"),Bool.and(inside(end,from,to),S.valid(start,end)))
      priorities(rest,from,to,Bool.pick(Priority,count_wait,add(admission,a,b),admission),
        Bool.pick(Priority,count_ci,add(ci,start,end),ci),Bool.pick(Priority,count_delay,add(delay,start,end),delay))

def ranked(a: Priority,b: Priority) -> Bool:
  match a b:
    case Priority{+x,+n,_,+ms,_} Priority{+y,+m,_,+other,_}:
      +first = String.eq(x,"Confirmed outcome delay")
      +second = String.eq(y,"Confirmed outcome delay")
      +more = Bool.or(Nat.is_gt(n,m),Bool.and(Nat.is_eq(n,m),Bool.or(Nat.is_gt(ms,other),Bool.and(Nat.is_eq(ms,other),String.is_lt(x,y)))))
      Bool.or(Bool.and(first,Bool.not(second)),Bool.and(Bool.not(Bool.or(first,second)),more))

def findings(items: List<&2, Priority>) -> List<&2, Issue>:
  match items:
    case []: []
    case Priority{kind,+occurrences,+measured,ms,next} <> rest:
      +tail = findings(rest)
      +total = Bool.pick(Maybe<&2,Nat>,Nat.is_gt(measured,0n),Some{ms},None{})
      Bool.pick(List<&2,Issue>,Nat.is_gt(occurrences,0n),Issue{kind,occurrences,measured,total,next} <> tail,tail)

def rank(records: List<&2, S.Evidence>, from: Nat, to: Nat) -> List<&2, Issue>:
  +input = priorities(records,from,to,
    Priority{"T3 admission",0n,0n,0n,"Compare request-to-start waits with T3 queue depth and provider capacity."},
    Priority{"CI failures",0n,0n,0n,"Compare the first failing step and runner logs across the linked attempts."},
    Priority{"Confirmed outcome delay",0n,0n,0n,"Review when the outcome was ready and what released the blocker."})
  findings(List.sort(~Priority,~ranked,input))
