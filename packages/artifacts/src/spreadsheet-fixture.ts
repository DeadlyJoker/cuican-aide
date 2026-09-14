import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

/** Small, actual OOXML workbook used by behavioral tests and file acceptance. */
export function exampleWorkbook(): Uint8Array {
  const xmlns =
    'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const names = ["Report", "Second", "Third", "Fourth"];
  const parts: Record<string, string> = {
    "[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
    "_rels/.rels":
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": `<workbook ${xmlns} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((name, i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": `<styleSheet ${xmlns}><fonts count="2"><font><color theme="1"/><family val="2"/><scheme val="minor"/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="13"/><color rgb="FF183153"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7F0FF"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FF006699"/></left><right/><top/><bottom style="double"><color rgb="FF006699"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="1" fillId="2" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf></cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": `<worksheet ${xmlns}><dimension ref="A1:E10"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols><col min="2" max="2" width="22" customWidth="1"/></cols><sheetData><row r="1" ht="28" customHeight="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>amount</t></is></c><c r="D1" t="inlineStr"><is><t>Manual note</t></is></c></row><row r="2"><c r="B2" s="1"/></row><row r="10"><c r="B10" s="1"><f>SUM(B2:B9)</f><v>999</v></c><c r="C10"><f>B10*2</f><v>1998</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="D1:E1"/></mergeCells><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`,
  };
  for (let i = 2; i <= 4; i++)
    parts[`xl/worksheets/sheet${i}.xml`] =
      `<worksheet ${xmlns}><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>amount</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>${i === 4 ? "fourth-row" : `row-${i}`}</t></is></c><c r="B2"><v>7</v></c></row></sheetData></worksheet>`;
  for (let i = 2; i <= 3; i++) {
    const key = `xl/worksheets/sheet${i}.xml`;
    parts[key] = parts[key]
      .replace('ref="A1:B2"', 'ref="A1:E2"')
      .replace(
        "<sheetData>",
        '<cols><col min="2" max="2" width="19" customWidth="1"/></cols><sheetData>',
      )
      .replace('<row r="1">', '<row r="1" ht="24" customHeight="1">')
      .replace(
        '</row><row r="2">',
        `<c r="D1" s="2" t="inlineStr"><is><t>Sheet note ${i}</t></is></c></row><row r="2">`,
      )
      .replace('<c r="B2">', '<c r="B2" s="2">')
      .replace(
        "</row></sheetData>",
        '<c r="C2" s="2"><f>B2*2</f><v>14</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="D1:E1"/></mergeCells>',
      );
  }
  parts["docProps/core.xml"] =
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>F01 fixture author</dc:creator><dc:title>Quarterly delivery</dc:title><dc:subject>Format retention</dc:subject><dc:description>Preserve reviewed metadata</dc:description><cp:lastModifiedBy>Input author</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-01-02T00:00:00Z</dcterms:modified></cp:coreProperties>';
  parts["[Content_Types].xml"] = parts["[Content_Types].xml"].replace(
    "</Types>",
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>',
  );
  parts["_rels/.rels"] = parts["_rels/.rels"].replace(
    "</Relationships>",
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>',
  );
  return zipSync(
    Object.fromEntries(
      Object.entries(parts).map(([name, xml]) => [name, strToU8(xml)]),
    ),
  );
}

export const orderInputA =
  "order_id,channel,currency,amount,status\nA001,直营,CNY,100.00,paid\nA002,直营,CNY,50.00,canceled\nA003,直营,CNY,80.00,paid\nA004,直营,USD,10.00,paid\n";
export const orderInputB =
  "order_id,channel,currency,amount,status\nB001,渠道,CNY,120.00,paid\nB002,渠道,CNY,,paid\nB003,渠道,CNY,30.00,paid\n";

export function orderTemplate(): Uint8Array {
  const parts = unzipSync(exampleWorkbook());
  const sheetNames = ["明细", "汇总", "异常", "来源"];
  parts["xl/workbook.xml"] = strToU8(
    strFromU8(parts["xl/workbook.xml"])
      .replace("Report", sheetNames[0])
      .replace("Second", sheetNames[1])
      .replace("Third", sheetNames[2])
      .replace("Fourth", sheetNames[3]),
  );
  const xmlns =
    'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const inline = (cell: string, value: string) =>
    `<c r="${cell}" t="inlineStr"><is><t>${value}</t></is></c>`;
  parts["xl/worksheets/sheet1.xml"] = strToU8(
    `<worksheet ${xmlns}><dimension ref="A1:I2"/><cols><col min="4" max="4" width="22" customWidth="1"/></cols><sheetData><row r="1" ht="28" customHeight="1">${["order_id", "channel", "currency", "amount", "status"].map((header, i) => inline(`${String.fromCharCode(65 + i)}1`, header)).join("")}${inline("H1", "用户原始备注")}</row><row r="2"><c r="D2" s="2"/></row></sheetData><mergeCells count="1"><mergeCell ref="H1:I1"/></mergeCells></worksheet>`,
  );
  parts["xl/worksheets/sheet2.xml"] = strToU8(
    `<worksheet ${xmlns}><dimension ref="A1:D2"/><sheetData><row r="1">${inline("A1", "channel")}${inline("B1", "currency")}${inline("C1", "amount")}${inline("D1", "核对公式")}</row><row r="2"><c r="C2" s="1"/><c r="D2" s="1"><f>C2*1</f><v>999</v></c></row></sheetData></worksheet>`,
  );
  for (let i = 3; i <= 4; i++)
    parts[`xl/worksheets/sheet${i}.xml`] = strToU8(
      `<worksheet ${xmlns}><sheetData/></worksheet>`,
    );
  return zipSync(parts);
}
