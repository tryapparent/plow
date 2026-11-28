import Base
import ./activity-spans.bend as S

def same(repo: String, run: String, attempt: String, sha: String, record: S.Evidence) -> Bool:
  match record:
    case S.Evidence{_,_,_,_,id,_,_,_,_,_,_,_,_,_,r,a,h,_}:
      Bool.and(String.eq(repo,r),Bool.and(String.eq(run,id),Bool.and(String.eq(attempt,a),String.eq(sha,h))))

type Link is Data:
  Unlinked{}
  Linked{thread: String}
  Ambiguous{}

def bind(previous: Link, +thread: String) -> Link:
  match previous:
    case Unlinked{}: Linked{thread}
    case Linked{other}: Bool.pick(Link,String.eq(thread,other),Linked{thread},Ambiguous{})
    case Ambiguous{}: Ambiguous{}

def nonempty(value: String) -> Bool:
  Bool.not(String.is_empty(value))

def exact(links: List<&2,S.Evidence>, +repo: String, +run: String, +attempt: String, +sha: String,
    +pr: String, +link: Link) -> Link:
  match links:
    case []: link
    case +row <> rest:
      match row:
        case S.Evidence{_,kind,_,+thread,_,_,number,_,_,_,_,_,_,_,owner_repo,_,_,_}:
          +direct = same(repo,run,attempt,sha,row)
          +through_pr = Bool.and(String.eq(kind,"t3_pr_link"),
            Bool.and(nonempty(pr),Bool.and(String.eq(pr,number),String.eq(repo,owner_repo))))
          +valid = Bool.and(nonempty(thread),Bool.or(direct,through_pr))
          exact(rest,repo,run,attempt,sha,pr,Bool.pick(Link,valid,bind(link,thread),link))

def identity(+repo: String,+run: String,+attempt: String,+sha: String) -> Bool:
  Bool.and(nonempty(repo),Bool.and(nonempty(run),Bool.and(nonempty(attempt),nonempty(sha))))

def attempt_row(rows: List<&2,S.Evidence>, +repo: String,+run: String,+attempt: String,+sha: String) -> Maybe<&2,S.Evidence>:
  match rows:
    case []: None{}
    case +row <> rest:
      Bool.pick(Maybe<&2,S.Evidence>,same(repo,run,attempt,sha,row),Some{row},attempt_row(rest,repo,run,attempt,sha))

def resolve_attempt(row: Maybe<&2,S.Evidence>, links: List<&2,S.Evidence>) -> Link:
  match row:
    case None{}: Unlinked{}
    case Some{S.Evidence{_,_,_,_,+run,_,pr,_,_,_,_,_,_,_,+repo,+attempt,+sha,_}}:
      Bool.pick(Link,identity(repo,run,attempt,sha),exact(links,repo,run,attempt,sha,pr,Unlinked{}),Unlinked{})

def evidence(row: S.Evidence, links: List<&2,S.Evidence>, attempts: List<&2,S.Evidence>) -> Link:
  match row:
    case S.Evidence{_,_,_,_,run,_,_,_,_,_,_,_,_,_,repo,attempt,sha,_}:
      resolve_attempt(attempt_row(attempts,repo,run,attempt,sha),links)

def linked(row: S.Evidence, match_link: Link, tail: List<&2,S.Evidence>) -> List<&2,S.Evidence>:
  match row match_link:
    case S.Evidence{src,kind,id,_,run,session,group,status,stamp,seen,rev,a,b,c,repo,attempt,sha,job} Linked{thread}:
      S.Evidence{src,kind,id,thread,run,session,group,status,stamp,seen,rev,a,b,c,repo,attempt,sha,job} <> tail
    case _ _: tail

def join(rows: List<&2,S.Evidence>, +links: List<&2,S.Evidence>, +attempts: List<&2,S.Evidence>) -> List<&2,S.Evidence>:
  match rows:
    case []: []
    case +item <> rest: linked(item,evidence(item,links,attempts),join(rest,links,attempts))

def lane(record: S.Evidence, +lo: Nat, +hi: Nat, +tail: List<&2,S.Thread>) -> List<&2,S.Thread>:
  match record:
    case S.Evidence{_,kind,_,_,run,_,_,+status,_,_,_,created,+start,end,repo,attempt,job_sha,job}:
      +attempt_lane = String.eq(kind,"github_actions_attempt")
      +label = Bool.pick(String,attempt_lane,"Attempt",String.concat(["Job ",job]))
      +id = String.concat([label," · ",repo," #",run,"/",attempt])
      +execute = Bool.pick(String,attempt_lane,"Attempt elapsed",
        Bool.pick(String,Bool.or(String.eq(status,"failure"),String.eq(status,"timed_out")),"Job failed","Job execution"))
      +queue = Bool.pick(String,attempt_lane,"Attempt queue","Job queue")
      +spans = S.clip(S.span(created,start,"CI",queue,"",S.span(start,end,"CI",execute,"",[])),lo,hi)
      Bool.pick(List<&2,S.Thread>,Nat.is_gt(List.length(&2,S.Span,spans),0n),S.Thread{id,spans} <> tail,tail)

def timeline(rows: List<&2,S.Evidence>, +from: Nat,+to: Nat) -> List<&2,S.Thread>:
  match rows:
    case []: []
    case head <> rest: lane(head,from,to,timeline(rest,from,to))
