import * as core from '@actions/core'
import { context, getOctokit } from '@actions/github'
import { GitHub } from '@actions/github/lib/utils'
import axios from 'axios'
import JSZip from 'jszip'
import * as process from 'process'
import { getInput } from '@actions/core'

export async function run(): Promise<void> {
  try {
    const octo: InstanceType<typeof GitHub> = getOctokit(
      process.env['GITHUB_TOKEN']!!
    )

    const workflow_run = context.payload.workflow_run as WorkflowRun

    const artifact = await octo.rest.actions
      .listWorkflowRunArtifacts({
        ...context.repo,
        run_id: workflow_run.id
      })
      .then(art => art.data.artifacts.find(ar => ar.name == 'maven-publish'))

    console.log(`Found artifact: ${artifact!.archive_download_url}`)

    const response = await axios.get(artifact!!.archive_download_url, {
      responseType: 'arraybuffer',
      headers: {
        Authorization: `Bearer ${process.env['GITHUB_TOKEN']!!}`
      }
    })

    const zip = await JSZip.loadAsync(response.data)

    const payload = JSON.parse(await zip.file('event.json')!.async('string'))

    const prNumber = (payload.pull_request?.number ?? 0) as number

    console.log(`PR number: ${prNumber}`)

    const filter = getInput('artifacts_base_path')
    const toUpload = zip.filter((_relativePath, file) => {
      return (
        !file.dir && file.name != 'event.json' && file.name.startsWith(filter)
      )
    })

    const basePath = `https://maven.pkg.github.com/${context.repo.owner}/${context.repo.repo}/pr${prNumber}/`
    let uploadAmount = 0
    for (const file of toUpload) {
      await axios.put(basePath + file.name, await file.async('arraybuffer'), {
        auth: {
          username: 'actions',
          password: process.env['GITHUB_TOKEN']!
        }
      })
      console.log(`Uploaded ${file.name}`)
      uploadAmount++
    }

    console.log(`Finished uploading ${uploadAmount} items`)
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}

interface WorkflowRun {
  id: number
}
