import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { setLocaleResolver } from '../shared/i18n.js'
import { competitionLeaderboardCsv } from '../server/src/competitions/leaderboard-csv.js'

afterEach(() => setLocaleResolver(() => 'ru'))

test('CSV headings follow the interface language', () => {
  setLocaleResolver(() => 'en')
  assert.equal(competitionLeaderboardCsv({ public: [], private: [] }), '\uFEFF"Public place","Participant","Public score","Private place","Private score"\r\n')
  setLocaleResolver(() => 'ru')
  assert.equal(competitionLeaderboardCsv({ public: [], private: [] }), '\uFEFF"Место public","Участник","Результат public","Место private","Результат private"\r\n')
})

test('legacy names cannot become formulas, including after whitespace, while negative scores remain numeric', () => {
  for (const name of ['=1+1', '+SUM(1)', '-1+2', '@person', '  =1+1', '\tname', '\rname', '\nname']) {
    const csv = competitionLeaderboardCsv({
      public: [{ entrantId: 'a', entrantName: name, submissionId: 's', place: 1, score: -0.1234567890123456, at: 1 }],
      private: [],
    })
    assert.ok(csv.endsWith(`"1","'${name}","-0.1234567890123456","",""\r\n`), name)
  }
})
