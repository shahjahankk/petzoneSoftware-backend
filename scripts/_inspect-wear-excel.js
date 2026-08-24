const XLSX = require('xlsx');
const path = 'C:\\Users\\HP\\Downloads\\wear total iteam input.xlsx';
const wb = XLSX.readFile(path);
console.log('Sheets:', wb.SheetNames);
for (const name of wb.SheetNames) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' });
  console.log(`\nSheet "${name}" rows:`, rows.length);
  console.log('Columns:', rows[0] ? Object.keys(rows[0]) : []);
  rows.slice(0, 15).forEach((r, i) => console.log(i + 1, JSON.stringify(r)));
}
