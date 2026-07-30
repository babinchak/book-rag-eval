import { promises as fs } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { getEvalSet } from '../main/evals'
import { configureLibraryDir } from '../main/library'

export async function exportEvalSetFile(
  bookId: string,
  evalSetId: string,
  outputPath: string,
  libraryDir?: string
): Promise<string> {
  if (libraryDir) configureLibraryDir(libraryDir)
  const evalSet = await getEvalSet(bookId, evalSetId)
  const absoluteOutputPath = resolve(outputPath)
  await fs.mkdir(dirname(absoluteOutputPath), { recursive: true })
  await fs.writeFile(absoluteOutputPath, `${JSON.stringify(evalSet, null, 2)}\n`, 'utf8')
  return absoluteOutputPath
}
