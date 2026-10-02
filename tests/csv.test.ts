import { describe, it, expect } from "vitest";
import { parseCsv, buildLeadsCsv, guardCell } from "@/lib/csv";

const SAMPLE = `first_name,last_name,email,practice_name,phone
Alex,Rivera,alex@example.com,Green Valley,480-555-0123
Jamie,Kim,jamie@example.com,Summit,602-555-0199`;

describe("parseCsv", () => {
  it("parses valid rows into candidates", () => {
    const res = parseCsv(SAMPLE);
    expect(res.totalRows).toBe(2);
    expect(res.globalErrors).toEqual([]);
    const usable = res.candidates.filter((c) => c.errors.length === 0 && !c.duplicate);
    expect(usable).toHaveLength(2);
    expect(usable[0].data.firstName).toBe("Alex");
    expect(usable[0].data.email).toBe("alex@example.com");
    expect(usable[0].data.practiceName).toBe("Green Valley");
  });

  it("flags missing required first_name", () => {
    const res = parseCsv("first_name,email\n,only@example.com\n");
    expect(res.candidates[0].errors.map((e) => e.path)).toContain("first_name");
  });

  it("flags invalid email format", () => {
    const res = parseCsv("first_name,email\nBob,not-an-email\n");
    expect(res.candidates[0].errors.map((e) => e.message)).toContain("Invalid email format");
  });

  it("detects duplicates within the file", () => {
    const csv = "first_name,email\nA,dup@example.com\nB,dup@example.com\n";
    const res = parseCsv(csv);
    const dupes = res.candidates.filter((c) => c.duplicate);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].data.email).toBe("dup@example.com");
  });

  it("detects duplicates against existing addresses (case-insensitive)", () => {
    const res = parseCsv("first_name,email\nA,DUP@example.com\n", ["dup@example.com"]);
    expect(res.candidates[0].duplicate).toBe(true);
  });

  it("normalizes header names (case, spaces)", () => {
    const res = parseCsv("First Name,EMAIL\nAlex,alex@example.com\n");
    expect(res.candidates[0].data.firstName).toBe("Alex");
    expect(res.candidates[0].data.email).toBe("alex@example.com");
  });

  it("stays tolerant of messy files (no block errors) and still flags broken rows", () => {
    const res = parseCsv('Title: Some list\n\nfirst_name,email\n"unterminated');
    expect(res.globalErrors).toEqual([]);
    expect(res.totalRows).toBe(1);
    expect(res.candidates[0].errors.length).toBeGreaterThan(0);
  });
});

describe("parseCsv with the Name / Company Name / Email / Phone format", () => {
  const LIST = `Name,Company Name,Email,Phone
John Smith,Green Valley Clinic,john@example.com,480-555-0100
Maria Garcia,"Summit Ortho",maria@example.com,602-555-0200`;

  it("maps columns and splits full names", () => {
    const res = parseCsv(LIST);
    expect(res.totalRows).toBe(2);
    expect(res.globalErrors).toEqual([]);
    const usable = res.candidates.filter((c) => c.errors.length === 0 && !c.duplicate);
    expect(usable).toHaveLength(2);
    expect(usable[0].data.firstName).toBe("John");
    expect(usable[0].data.lastName).toBe("Smith");
    expect(usable[0].data.email).toBe("john@example.com");
    expect(usable[0].data.practiceName).toBe("Green Valley Clinic");
    expect(usable[0].data.phone).toBe("480-555-0100");
  });

  it("supports quoted multi-word companies and single-word names", () => {
    const res = parseCsv(`Name,Company Name,Email,Phone\nMaria,${'"Summit Ortho"'},maria@example.com,602\n`);
    expect(res.candidates[0].data.firstName).toBe("Maria");
    expect(res.candidates[0].data.lastName).toBeNull();
    expect(res.candidates[0].data.practiceName).toBe("Summit Ortho");
  });

  it("is case-insensitive and space-insensitive on headers", () => {
    const res = parseCsv("NAME,COMPANY NAME,EMAIL,PHONE\nJane Doe,ABC,j@example.com,123\n");
    expect(res.candidates[0].data.firstName).toBe("Jane");
    expect(res.candidates[0].data.lastName).toBe("Doe");
    expect(res.candidates[0].data.practiceName).toBe("ABC");
  });

  it("prefers explicit first_name/last_name columns when both exist", () => {
    const res = parseCsv("Name,first_name,last_name,Email\nJohn Smith,Jane,Jones,j@example.com\n");
    expect(res.candidates[0].data.firstName).toBe("Jane");
    expect(res.candidates[0].data.lastName).toBe("Jones");
  });

  it("still flags missing required name/email", () => {
    const res = parseCsv("Name,Email,Phone\n,only,a\n");
    const errs = res.candidates[0].errors.map((e) => e.path);
    expect(errs).toContain("first_name");
    expect(errs).toContain("email");
  });

  it("handles tab-separated files with a title row and quoted commas inside cells", () => {
    const res = parseCsv(
      "Leads Export\n" +
        '\tName\tCompany Name\tEmail\tPhone\n' +
        '\tDan Cole\tBright Smile\tdan@example.com\t555\n' +
        '\tSue Lin, DC\tSpine Center\tsue@example.com\t666\n',
    );
    expect(res.totalRows).toBe(2);
    expect(res.globalErrors).toEqual([]);
    const usable = res.candidates.filter((c) => c.errors.length === 0);
    expect(usable).toHaveLength(2);
    expect(usable[1].data.firstName).toBe("Sue");
    expect(usable[1].data.email).toBe("sue@example.com");
    expect(usable[1].data.practiceName).toBe("Spine Center");
  });
});

describe("CSV export injection protection", () => {
  it("prefixes formula characters", () => {
    expect(guardCell("=cmd()")).toBe("'=cmd()");
    expect(guardCell("+SUM(A1)")).toBe("'+SUM(A1)");
    expect(guardCell("-2+3")).toBe("'-2+3");
    expect(guardCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(guardCell("normal text")).toBe("normal text");
    expect(guardCell(null)).toBe("");
  });

  it("buildLeadsCsv guards every cell", () => {
    const csv = buildLeadsCsv([
      {
        firstName: "=HARM",
        lastName: null,
        email: "a@example.com",
        practiceName: "+EVIL",
        phone: "123",
        customField1: "@steal",
        customField2: "safe",
      },
    ]);
    expect(csv).toContain("'=HARM");
    expect(csv).toContain("'+EVIL");
    expect(csv).toContain("'@steal");
    expect(csv).not.toContain("\n=HARM");
  });
});