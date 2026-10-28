// Gives the Framecast.exe copy of node.exe its own icon and version info, so
// Explorer and Task Manager show "Framecast" instead of "Node.js".
// Usage: node set-exe-resources.mjs <exe> <ico> <version>
import fs from "node:fs";
import * as PE from "pe-library";
import * as ResEdit from "resedit";

const [exePath, icoPath, version] = process.argv.slice(2);
if (!exePath || !icoPath || !version) {
  console.error("usage: set-exe-resources.mjs <exe> <ico> <version>");
  process.exit(2);
}

const exe = PE.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
const res = PE.NtExecutableResource.from(exe);
const LANG = 1033; // en-US

const icon = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
const groupId = groups[0]?.id ?? 1;
const groupLang = groups[0]?.lang ?? LANG;
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
  res.entries, groupId, groupLang, icon.icons.map((i) => i.data),
);

const [major, minor, patch] = version.split(".").map(Number);
const infos = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
const vi = infos[0] ?? ResEdit.Resource.VersionInfo.createEmpty();
vi.setFileVersion(major, minor, patch, 0, LANG);
vi.setProductVersion(major, minor, patch, 0, LANG);
const lang = { lang: vi.getAllLanguagesForStringValues()[0]?.lang ?? LANG, codepage: 1200 };
vi.setStringValues(lang, {
  FileDescription: "Framecast",
  ProductName: "Framecast",
  InternalName: "Framecast",
  OriginalFilename: "Framecast.exe",
  CompanyName: "Framecast",
  FileVersion: version,
  ProductVersion: version,
  LegalCopyright: "Framecast. Includes Node.js (MIT); see THIRD-PARTY-NOTICES.txt.",
});
vi.outputToResourceEntries(res.entries);

res.outputResource(exe);
fs.writeFileSync(exePath, Buffer.from(exe.generate()));
console.log(`Set icon and version ${version} on ${exePath}`);
