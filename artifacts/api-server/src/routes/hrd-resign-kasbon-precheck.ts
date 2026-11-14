import type { PoolClient } from "pg";

export type HrdResignKasbonPrecheck = {
  unverifiedCount:number;
  unverifiedAmount:string;
  verifiedUnsettledCount:number;
  verifiedUnsettledAmount:string;
  activeReservations:number;
  activeReservationAmount:string;
  hasUnresolved:boolean;
  canDeactivate:boolean;
};

function nonnegativeCount(raw:unknown):number {
  const n=Number(raw);
  if(!Number.isSafeInteger(n)||n<0)throw Error("HRD_KASBON_PREFLIGHT_INVALID_COUNT");
  return n;
}
function nonnegativeAmount(raw:unknown):string {
  const s=String(raw??"");
  if(!/^(0|[1-9][0-9]{0,15})(?:\.[0-9]{1,2})?$/.test(s))
    throw Error("HRD_KASBON_PREFLIGHT_INVALID_AMOUNT");
  return s;
}

/** Only a company-verified, role-scoped aggregate with no financial table grants. */
export async function getEmployeeResignKasbonPrecheck(
  client:Pick<PoolClient,"query">,companyId:number,employeeId:number
):Promise<HrdResignKasbonPrecheck> {
  if(!Number.isSafeInteger(companyId)||companyId<=0||
     !Number.isSafeInteger(employeeId)||employeeId<=0)
    throw Error("HRD_KASBON_PREFLIGHT_BAD_ID");
  const result=await client.query(
    `SELECT unverified_count AS "unverifiedCount",
            unverified_amount::text AS "unverifiedAmount",
            verified_unsettled_count AS "verifiedUnsettledCount",
            verified_unsettled_amount::text AS "verifiedUnsettledAmount",
            active_reservations AS "activeReservations",
            active_reservation_amount::text AS "activeReservationAmount"
       FROM hrd_private.employee_resign_kasbon_precheck($1::integer,$2::integer)`,
    [companyId,employeeId],
  );
  if(result.rowCount!==1||!result.rows[0])throw Error("HRD_KASBON_PREFLIGHT_NO_RESULT");
  const r=result.rows[0] as Record<string,unknown>;
  const unverifiedCount=nonnegativeCount(r.unverifiedCount);
  const verifiedUnsettledCount=nonnegativeCount(r.verifiedUnsettledCount);
  const activeReservations=nonnegativeCount(r.activeReservations);
  const unverifiedAmount=nonnegativeAmount(r.unverifiedAmount);
  const verifiedUnsettledAmount=nonnegativeAmount(r.verifiedUnsettledAmount);
  const activeReservationAmount=nonnegativeAmount(r.activeReservationAmount);
  const hasUnresolved=unverifiedCount>0||verifiedUnsettledCount>0||activeReservations>0;
  return {unverifiedCount,unverifiedAmount,verifiedUnsettledCount,verifiedUnsettledAmount,
    activeReservations,activeReservationAmount,hasUnresolved,canDeactivate:!hasUnresolved};
}
