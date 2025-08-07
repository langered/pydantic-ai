/// <reference types="npm:@types/node@22.12.0" />

import type { LoggingLevel } from '@modelcontextprotocol/sdk/types.js'
import { walk } from '@std/fs/walk'
import { relative } from '@std/path'

export interface FileInfo {
  type: 'text' | 'binary'
  content: string
}

export interface MountPathInfo {
  localPath: string
  pyodidePath: string
}

/**
 * Parse mount path string in format "local_path:pyodide_path"
 * Returns null if format is invalid
 */
export function parseMountPath(mountPath: string): MountPathInfo | null {
  const [localPath, pyodidePath] = mountPath.split(':')
  if (localPath && pyodidePath) {
    return { localPath, pyodidePath }
  }
  return null
}

/**
 * Handle filesystem mounting with path parsing and validation
 */
// deno-lint-ignore no-explicit-any
export async function handleMount(pyodide: any, mountPath: string, log: (level: LoggingLevel, data: string) => void) {
  const mountInfo = parseMountPath(mountPath)
  if (mountInfo) {
    await mountFilesToPyodide(pyodide, mountInfo.localPath, mountInfo.pyodidePath, log)
  } else {
    log('warning', 'Invalid mount path format. Use: local_path:pyodide_path')
  }
}

/**
 * Handle filesystem sync back with path parsing and validation
 */
// deno-lint-ignore no-explicit-any
export async function handleSyncBack(pyodide: any, mountPath: string, log: (level: LoggingLevel, data: string) => void) {
  const mountInfo = parseMountPath(mountPath)
  if (mountInfo) {
    try {
      await syncFilesFromPyodide(pyodide, mountInfo.pyodidePath, mountInfo.localPath, log)
    } catch (error) {
      log('warning', `Failed to sync files back to ${mountInfo.localPath}: ${error}`)
    }
  }
}

/**
 * Read all files from a local directory and return them as a map
 * with relative paths as keys and file info as values
 */
export async function readLocalDirectory(localPath: string): Promise<Map<string, FileInfo>> {
  const files = new Map<string, FileInfo>()
  
  try {
    for await (const entry of walk(localPath, { includeFiles: true, includeDirs: false })) {
      if (entry.isFile) {
        const relativePath = relative(localPath, entry.path)
        
        try {
          // Try to read as text first
          const content = await Deno.readTextFile(entry.path)
          files.set(relativePath, { type: 'text', content })
        } catch {
          // If text reading fails, read as binary and encode as base64
          const binaryContent = await Deno.readFile(entry.path)
          const encodedContent = btoa(String.fromCharCode(...binaryContent))
          files.set(relativePath, { type: 'binary', content: encodedContent })
        }
      }
    }
  } catch (error) {
    throw new Error(`Failed to read directory ${localPath}: ${error}`)
  }
  
  return files
}

/**
 * Mount local filesystem files to Pyodide filesystem
 */
// deno-lint-ignore no-explicit-any
export async function mountFilesToPyodide(pyodide: any, localPath: string, pyodidePath: string, log: (level: LoggingLevel, data: string) => void) {
  try {
    // Read the local directory contents
    const localFiles = await readLocalDirectory(localPath)
    
    // Import Python modules we need
    const pathlib = pyodide.pyimport('pathlib')
    const base64 = pyodide.pyimport('base64')
    
    // Create the mount directory
    const mountDir = pathlib.Path(pyodidePath)
    mountDir.mkdir({ parents: true, exist_ok: true })
    
    for (const [relativePath, fileInfo] of localFiles) {
      const targetPath = `${pyodidePath}/${relativePath}`
      const targetPathObj = pathlib.Path(targetPath)
      
      // Ensure parent directory exists
      targetPathObj.parent.mkdir({ parents: true, exist_ok: true })
      
      if (fileInfo.type === 'text') {
        // Write text file directly
        targetPathObj.write_text(fileInfo.content)
      } else if (fileInfo.type === 'binary') {
        // Decode base64 and write binary file
        const binaryData = base64.b64decode(fileInfo.content)
        targetPathObj.write_bytes(binaryData)
      }
    }
    
    log('info', `Mounted ${localPath} to ${pyodidePath}`)
  } catch (error) {
    log('warning', `Failed to mount ${localPath}: ${error}`)
  }
}

/**
 * Sync files from Pyodide filesystem back to local filesystem
 */
// deno-lint-ignore no-explicit-any
export async function syncFilesFromPyodide(pyodide: any, pyodidePath: string, localPath: string, log: (level: LoggingLevel, data: string) => void) {
  try {
    // Import Python modules we need
    const pathlib = pyodide.pyimport('pathlib')
    const base64 = pyodide.pyimport('base64')
    
    // Get the mount directory
    const mountPath = pathlib.Path(pyodidePath)
    
    if (!mountPath.exists()) {
      log('info', `Mount path ${pyodidePath} does not exist, nothing to sync`)
      return
    }
    
    const filesData: Record<string, FileInfo> = {}
    
    // Iterate through all files in the mount directory
    const allFiles = mountPath.rglob('*')
    for (const filePath of allFiles) {
      if (filePath.is_file()) {
        try {
          const relativePath = filePath.relative_to(mountPath).toString()
          
          // Try to read as text first
          try {
            const content = filePath.read_text({ encoding: 'utf-8' })
            filesData[relativePath] = {
              type: 'text',
              content: content
            }
          } catch {
            // If text reading fails, read as binary and encode as base64
            const binaryContent = filePath.read_bytes()
            const encodedContent = base64.b64encode(binaryContent).decode('ascii')
            filesData[relativePath] = {
              type: 'binary',
              content: encodedContent
            }
          }
        } catch (error) {
          log('warning', `Error reading file ${filePath}: ${error}`)
        }
      }
    }
    
    // Write each file back to the local filesystem
    for (const [relativePath, fileInfo] of Object.entries(filesData)) {
      const localFilePath = `${localPath}/${relativePath}`
      
      // Ensure parent directory exists
      const parentDir = localFilePath.substring(0, localFilePath.lastIndexOf('/'))
      if (parentDir !== localPath) {
        await Deno.mkdir(parentDir, { recursive: true })
      }
      
      // Write the file based on its type
      if (fileInfo.type === 'text') {
        await Deno.writeTextFile(localFilePath, fileInfo.content)
      } else if (fileInfo.type === 'binary') {
        // Decode base64 and write as binary
        const binaryData = new Uint8Array(
          atob(fileInfo.content)
            .split('')
            .map(char => char.charCodeAt(0))
        )
        await Deno.writeFile(localFilePath, binaryData)
      }
    }
    
    const fileCount = Object.keys(filesData).length
    if (fileCount > 0) {
      log('info', `Synced ${fileCount} files (text and binary) from ${pyodidePath} back to ${localPath}`)
    }
  } catch (error) {
    throw new Error(`Failed to sync files from Pyodide: ${error}`)
  }
}
