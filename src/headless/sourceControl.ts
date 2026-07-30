import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { contentHash } from '../shared/artifactIdentity'

const execFileAsync = promisify(execFile)

export interface SourceControlState {
  gitCommit: string | null
  workingTreeDiffHash: string | null
}

export async function readSourceControlState(): Promise<SourceControlState> {
  const projectDir = process.env.BOOK_RAG_EVAL_APP_DIR ?? process.cwd()
  try {
    const [{ stdout: commit }, { stdout: diff }] = await Promise.all([
      execFileAsync('git', ['-C', projectDir, 'rev-parse', 'HEAD'], {
        encoding: 'utf8'
      }),
      execFileAsync('git', ['-C', projectDir, 'diff', '--binary', 'HEAD', '--'], {
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024
      })
    ])
    return {
      gitCommit: commit.trim(),
      workingTreeDiffHash: diff.length > 0 ? contentHash(diff) : null
    }
  } catch {
    return { gitCommit: null, workingTreeDiffHash: null }
  }
}
