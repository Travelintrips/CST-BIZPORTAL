import {afterEach,describe,expect,it,vi} from "vitest";
import {hrdEmployeeStatusChangeEnabled} from "./hrd-employee-status-gate";
afterEach(()=>vi.unstubAllEnvs());
describe("HRD employee status permission follows existing scoped service",()=>{
  it("enables existing authenticated HRD workflow without a second flag",()=>{
    vi.stubEnv("APP_ENV","production");
    vi.stubEnv("HRD_PROD_ENABLED","true");
    vi.stubEnv("HRD_EMPLOYEE_STATUS_WRITE_ENABLED","");
    expect(hrdEmployeeStatusChangeEnabled()).toBe(true);
  });
  it("honors explicit false kill switch",()=>{
    vi.stubEnv("APP_ENV","production");
    vi.stubEnv("HRD_PROD_ENABLED","true");
    vi.stubEnv("HRD_EMPLOYEE_STATUS_WRITE_ENABLED","false");
    expect(hrdEmployeeStatusChangeEnabled()).toBe(false);
  });
  it("never enables status changes if HRD or PROD is off",()=>{
    vi.stubEnv("APP_ENV","development");
    vi.stubEnv("HRD_PROD_ENABLED","true");
    vi.stubEnv("HRD_EMPLOYEE_STATUS_WRITE_ENABLED","true");
    expect(hrdEmployeeStatusChangeEnabled()).toBe(false);
    vi.stubEnv("APP_ENV","production");
    vi.stubEnv("HRD_PROD_ENABLED","false");
    expect(hrdEmployeeStatusChangeEnabled()).toBe(false);
  });
});