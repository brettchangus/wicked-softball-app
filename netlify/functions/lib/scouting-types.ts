export type Scope = { teamKey:string; seasonKey:string; eventKey:string };
export type Level = { group:'B'|'C'; basis:string; source:string|null; reason?:string; reviewedAt?:string; games:number; largeLosses:number; share:number|null };
export type Counts = Record<string, number|null>;
export type PlayerLine = { id:string; name:string; number:string; stats:Counts; positions:string[] };
export type ScoutGame = {
  id:string; date:string; opponent:string; opponentId:string|null; opponentPublicId:string|null;
  rf:number; ra:number; source:string; kind:string; innings:number[];
  hitters:PlayerLine[]; pitchers:PlayerLine[]; warnings:string[]; boxScore:boolean; level?:Level;
  // The provider team id in this tournament the opponent was matched to, when it is one of its teams.
  opponentTeamId?:string|null;
};
export type Collection = { publicId:string; name:string; season:string; year?:number|null; seasonName?:string|null; games:ScoutGame[]; warnings:string[]; collectedAt:string };
export type Opponent = { id:string; name:string; role:string; gameKeys:string[]; firstPitch:string|null };
export type Eligibility = { bracketsSet:boolean; opponents:Opponent[] };
// The scouted team's own class and state rank, as of report generation. `source` names who rated
// it ("NorCal", or "the tournament" for a level read from the tournament structure).
export type TeamRating = { level:string|null; rank:number|null; rankOf:number|null; source:string };
export type SavedReport = {
  levelRevision?:string|null; rating?:TeamRating|null;
  startDate?:string; opponent:Opponent; generatedAt:string; refreshedAt:string|null; asOf:string; methodVersion:number;
  sourceUrl:string; sourceFingerprint:string; collection:Collection;
  // Class views, stored only by reports saved before views were derived on read; ignored.
  views?:Record<string, unknown>;
  history:{ scope:string; meetings:unknown[]; warnings:string[] }; warnings:string[];
};
export type ReportSummary = { methodVersion?:number; id:string; name:string; generatedAt:string; refreshedAt:string|null; asOf:string; sourceUrl:string; levelRevision?:string|null };
