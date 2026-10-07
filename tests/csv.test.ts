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

  it("accepts a row with a valid email and no name", () => {
    const res = parseCsv("first_name,email\n,only@example.com\n");
    expect(res.candidates[0].errors).toEqual([]);
    expect(res.candidates[0].data.firstName).toBe("");
    expect(res.candidates[0].data.email).toBe("only@example.com");
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

  it("rejects a row whose email is invalid without blaming missing name", () => {
    const res = parseCsv("Name,Email,Phone\n,only,a\n");
    const errs = res.candidates[0].errors.map((e) => e.path);
    expect(errs).toContain("email");
    expect(errs).not.toContain("first_name");
    expect(res.candidates[0].errors.map((e) => e.message)).toContain("Invalid email format");
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

describe("campaign lead rules — email is the ONLY required field", () => {
  const usable = (line: string) => {
    const res = parseCsv(`email,firstName,lastName,company,phone\n${line}`);
    return res.candidates[0];
  };

  // Individual acceptance: any valid unique email is a valid lead, alone or
  // with a single optional field filled in.
  it.each([
    ["TEST 1: valid email only", "john@example.com,,,,"],
    ["TEST 2: valid email + first name", "john@example.com,John,,,"],
    ["TEST 3: valid email + last name", "john@example.com,,Smith,,"],
    ["TEST 4: valid email + company", "john@example.com,,,ABC Medical,"],
    ["TEST 5: valid email + phone", "john@example.com,,,,480-555-0123"],
    ["TEST 9: valid email, all optional fields missing", "john@example.com,,,,"],
  ])("%s", (_label, row) => {
    const c = usable(row);
    expect(c.errors).toEqual([]);
    expect(c.duplicate).toBe(false);
    expect(c.data.email).toBe("john@example.com");
  });

  it("TEST 1/6: email-only rows keep every optional field empty (no placeholders)", () => {
    const c = usable("john@example.com,,,,");
    expect(c.data.firstName).toBe("");
    expect(c.data.lastName).toBeNull();
    expect(c.data.practiceName).toBeNull();
    expect(c.data.phone).toBeNull();
    expect(c.data.customField1).toBeNull();
    expect(c.data.customField2).toBeNull();
  });

  it("TEST 3: last name alone is preserved with no invented first name", () => {
    const c = usable("john@example.com,,Smith,,");
    expect(c.data.firstName).toBe("");
    expect(c.data.lastName).toBe("Smith");
  });

  it("TEST 7: missing email is rejected with a 'Missing email' error", () => {
    const res = parseCsv("email,firstName,lastName,company,phone\n,John,Smith,ABC Medical,123\n");
    const c = res.candidates[0];
    expect(c.errors.map((e) => e.message)).toContain("Missing email");
    expect(c.errors.some((e) => e.path === "email")).toBe(true);
  });

  it("TEST 8: syntactically invalid email is rejected", () => {
    const res = parseCsv("email,firstName,lastName,company,phone\nnot-a-real-email,John,Smith,ABC Medical,123\n");
    expect(res.candidates[0].errors.map((e) => e.message)).toContain("Invalid email format");
  });

  it("TEST 11: mixed file — every row with a valid unique email is accepted", () => {
    const csv = [
      "email,firstName,lastName,company,phone",
      "john@example.com,,,,",
      "jane@example.com,Jane,,,",
      "bob@example.com,,Smith,,",
      "alice@example.com,,,ABC Medical,",
      "tom@example.com,Tom,Jones,ABC Medical,",
    ].join("\n");
    const res = parseCsv(csv);
    expect(res.totalRows).toBe(5);
    expect(res.globalErrors).toEqual([]);
    for (const c of res.candidates) {
      expect(c.errors).toEqual([]);
      expect(c.duplicate).toBe(false);
    }
    expect(res.candidates[0].data.firstName).toBe("");
    expect(res.candidates[1].data.firstName).toBe("Jane");
    expect(res.candidates[2].data.lastName).toBe("Smith");
    expect(res.candidates[3].data.practiceName).toBe("ABC Medical");
    expect(res.candidates[4].data.lastName).toBe("Jones");
  });

  it("TEST 10: duplicate valid emails still follow existing duplicate rules", () => {
    const res = parseCsv("email,firstName\ndup@example.com,A\ndup@example.com,B\n");
    const dupes = res.candidates.filter((c) => c.duplicate);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].data.email).toBe("dup@example.com");
    expect(res.candidates[0].data.firstName).toBe("A");
    expect(res.candidates[1].data.firstName).toBe("B");
  });

  it("accepts camelCase headers, preserving optional fields", () => {
    const res = parseCsv("email,firstName,lastName,practiceName,phone\nj@example.com,Jane,Smith,ABC,555\n");
    expect(res.candidates[0].data.firstName).toBe("Jane");
    expect(res.candidates[0].data.lastName).toBe("Smith");
    expect(res.candidates[0].data.practiceName).toBe("ABC");
    expect(res.candidates[0].data.phone).toBe("555");
    expect(res.candidates[0].errors).toEqual([]);
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