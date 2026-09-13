/** Проверка анкоров подсветки PDF: стемминг, скоринг, границы предложений. */
import { stemWord, tokenize, sigWords } from '../frontend/src/utils/stem'
import { findAnchor, expandToSentences, scorePageText } from '../frontend/src/components/PdfViewerModal'

let pass = 0
let fail = 0
function ok(cond: boolean, name: string, extra?: unknown) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}`, extra ?? '')
  }
}

const vw = (words: string[]) => words.map((w, i) => ({ w: stemWord(w), item: i, str: w }))

console.log('стемминг:')
ok(stemWord('коридора') === stemWord('коридоров'), 'коридора/коридоров один стем', [stemWord('коридора'), stemWord('коридоров')])
ok(stemWord('ширина') === stemWord('ширину'), 'ширина/ширину один стем')
ok(stemWord('эвакуационных') !== stemWord('эвакуационный'), 'их/ых нет в суффиксах — паритет с build_index.py (документировано)')
ok(JSON.stringify(tokenize('Ширина коридора 1,4 м')) === JSON.stringify(['ширин', 'коридор']), 'tokenize 1-в-1', tokenize('Ширина коридора 1,4 м'))

console.log('findAnchor:')
const page1 = vw('пожарная безопасность зданий ширина коридоров должна быть не менее полутора метров при длине'.split(' '))
const h1 = findAnchor(page1, 'Ширина коридоров должна быть не менее 1,4 м')
ok(!!h1 && h1.score === 1, 'точное вхождение score=1', h1)
const page2 = vw('требования ширину коридора следует принимать менее полутора метров запрещается сужать'.split(' '))
const h2 = findAnchor(page2, 'Ширина коридоров должна быть не менее 1,4 м')
ok(!!h2 && h2.matched >= 3, 'парафраз с окончаниями находится', h2)
const longQuote = 'вводная вода общие положения бла бла Ширина коридоров должна быть не менее полутора метров конец конец завершение итог'
const h3 = findAnchor(page1, longQuote)
ok(!!h3, 'якорь из середины длинной цитаты', h3)
ok(findAnchor(page1, 'абракадабра несуществующий термин синхрофазотрон') === null, 'мусор → null')
ok(findAnchor(page1, 'да') === null, 'короткая цитата → null')

console.log('expandToSentences:')
const sent = ['Ширина', 'коридоров', '1,4', 'м.', 'Высота', 'потолков', '2,5', 'м.']
const vws = sent.map((w, i) => ({ w: stemWord(w), item: i, str: w }))
const ex = expandToSentences(vws, 5, 6)
ok(ex.fromItem === 4 && ex.toItem === 7, 'расширение до границ предложений', ex)
const noPunct = 'строка один два три четыре пять шесть семь восемь девять десять одиннадцать двенадцать тринадцать четырнадцать пятнадцать шестнадцать семнадцать восемнадцать девятнадцать двадцать двадцатьодин двадцатьдва двадцатьтри двадцатьчетыре двадцатьпять двадцатьшесть двадцатьсемь двадцатьвосемь двадцатьдевять тридцать'.split(' ')
const vwn = noPunct.map((w, i) => ({ w: stemWord(w), item: i, str: w }))
const exn = expandToSentences(vwn, 10, 12)
ok(exn.toItem - exn.fromItem <= 50, 'кап расширения без пунктуации (таблицы)', exn)

console.log('scorePageText:')
const tc = { items: [{ str: 'Ширина коридоров' }, { str: 'не менее 1,4 м' }] }
ok(scorePageText(tc, 'ширина коридоров должна быть') > 0.5, 'скоринг страницы', scorePageText(tc, 'ширина коридоров должна быть'))
ok(scorePageText({ items: [] }, 'ширина коридоров') === 0, 'пустая страница → 0')

console.log(`\nИТОГ: pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)
