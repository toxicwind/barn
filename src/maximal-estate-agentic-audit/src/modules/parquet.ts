import { ParquetWriter, ParquetSchema } from "parquetjs-lite";
import type { LocalAuditResult } from "./types.js";
import { toDataFrame } from "./dataframe.js";

export async function exportParquet(result: LocalAuditResult, path: string): Promise<void> {
  const schema = new ParquetSchema({
    name: { type: "UTF8" },
    path: { type: "UTF8" },
    area: { type: "UTF8" },
    isGit: { type: "BOOLEAN" },
    remoteUrl: { type: "UTF8" },
    branch: { type: "UTF8" },
    lastCommit: { type: "UTF8" },
    lastCommitDate: { type: "UTF8" },
    status: { type: "UTF8" },
    symlinkCount: { type: "INT32" },
    issueCount: { type: "INT32" },
  });
  const rows = toDataFrame(result);
  const numRows = result.records.length;
  const writeStream = await ParquetWriter.openFile(schema, path);
  for (let i = 0; i < numRows; i++) {
    await writeStream.appendRow({
      name: rows.name[i], path: rows.path[i], area: rows.area[i],
      isGit: rows.isGit[i], remoteUrl: rows.remoteUrl[i], branch: rows.branch[i],
      lastCommit: rows.lastCommit[i], lastCommitDate: rows.lastCommitDate[i],
      status: rows.status[i], symlinkCount: rows.symlinkCount[i], issueCount: rows.issueCount[i],
    });
  }
  await writeStream.close();
}
