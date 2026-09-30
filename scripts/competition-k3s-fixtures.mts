/**
 * The disposable competition both Kubernetes checks run: the k3s smoke
 * (competition-k3s-app-fixture.mts, straight through the runner inside a
 * fixture Pod) and the Helm end-to-end check (k8s-e2e.mts, through the admin
 * API of an installed chart). One copy, so the two cannot drift into proving
 * different things.
 *
 * Every piece checks the isolation of the Pod it runs in, not just that it ran:
 * the notebook sees neither the answers nor the result directory and cannot
 * reach the internet; the metric sees the answers but neither the open data
 * nor the installed packages. Each sleeps a few seconds so that a watcher
 * polling the cluster sees its Pod.
 */

export const SMOKE_METRIC_CODE = `def score(solution, submission):
    from pathlib import Path
    import time
    assert Path('/secret/solution.csv').exists()
    assert not Path('/data').exists()
    assert not Path('/deps').exists()
    time.sleep(5)
    return float((solution['target'] - submission['target']).abs().mean())
`

export const SMOKE_SAMPLE_SUBMISSION = 'id,target\n1,0\n2,0\n3,0\n4,0\n'

/** Two public rows and two private ones, split by the Usage column. */
export const SMOKE_SOLUTION = 'id,target,Usage\n1,0,Public\n2,0,Public\n3,0,Private\n4,0,Private\n'

/** A notebook that answers the sample exactly: both scores are 0. */
export function smokeNotebook(): Buffer {
  return Buffer.from(JSON.stringify({ nbformat: 4, nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
    cells: [{ cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: [
      'from pathlib import Path\n', 'import socket, time\n',
      'assert not Path("/secret").exists()\n', 'assert not Path("/result").exists()\n',
      'try:\n', '    socket.create_connection(("1.1.1.1", 443), 1)\n',
      'except OSError:\n', '    pass\n', 'else:\n', '    raise AssertionError("competition egress is open")\n',
      'time.sleep(5)\n', 'Path("submission.csv").write_text("id,target\\n1,0\\n2,0\\n3,0\\n4,0\\n")\n',
    ] }] }))
}
