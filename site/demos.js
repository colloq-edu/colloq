/*
 * Живые куски лендинга: рейка присутствия в герое, чужие каретки в
 * заголовке, экран входа и две ячейки одного ядра.
 *
 * Скрипт общий для русской и английской страницы. Всё, что зависит от
 * языка — имена, слова-числа, сорок меток, реплики ядра — страница кладёт
 * в window.COLLOQ_I18N перед подключением этого файла. Разводить два
 * экземпляра тысячи строк ради «вошла/joined» нельзя: они разойдутся в
 * первый же день, и разойдутся молча.
 */
;(function () {
  'use strict'

  /*
   * Явный выбор языка. Клик по метке в шапке запоминается, и с этого
   * момента автоопределение в <head> молчит: человек, который один раз
   * сказал «мне по-русски», не должен говорить это на каждой вкладке.
   *
   * Запись идёт синхронно в обработчике — до того, как браузер уйдёт по
   * ссылке, — поэтому отдельного preventDefault не нужно. Блок стоит до
   * проверки словаря: переключатель обязан работать и на странице, где
   * живых демо нет вовсе.
   */
  try {
    var picker = document.querySelector('.lang-switch')
    if (picker) {
      picker.addEventListener('click', function (e) {
        var link = e.target && e.target.closest ? e.target.closest('a.lang-option') : null
        if (!link) return
        try {
          localStorage.setItem('colloq-site-lang', link.getAttribute('data-lang'))
        } catch (err) {}
      })
    }
  } catch (e) {}

  var S = window.COLLOQ_I18N
  /* Без словаря показывать нечего: демо целиком состоит из его строк. */
  if (!S) return

  var reduce = false
  try {
    reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch (e) {}

  var ROSTER = S.roster

  /* ------------------------------------------- рейка присутствия в герое */
  try {
    ;(function () {
      var room = document.getElementById('room')
      var roomN = document.getElementById('room-n')
      var sayBox = document.getElementById('room-say')
      if (!room || reduce) return

      var PEOPLE = ROSTER
      var WORDS = S.counts

      var SEATS = 4
      var inside = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]

      var pool = [12, 13, 14, 15]
      var nodes = {}
      var chip = null

      var circle = function (text, tint) {
        var el = document.createElement('span')
        el.textContent = text
        el.style.background = tint
        return el
      }

      var fadeOut = function (el) {
        var r = el.getBoundingClientRect()
        var box = room.getBoundingClientRect()
        el.style.position = 'absolute'
        el.style.left = r.left - box.left + 'px'
        el.style.top = r.top - box.top + 'px'
        el.style.margin = '0'
        el.classList.remove('is-new')
        el.classList.add('is-out')

        room.appendChild(el)
        window.setTimeout(function () {
          el.remove()
        }, 380)
      }

      var render = function () {
        var want = inside.slice(0, SEATS)

        var before = new Map()
        Array.prototype.forEach.call(room.children, function (el) {
          before.set(el, el.getBoundingClientRect().left)
        })

        Object.keys(nodes).forEach(function (key) {
          if (want.indexOf(Number(key)) === -1) {
            fadeOut(nodes[key])
            delete nodes[key]
          }
        })

        var order = []
        want.forEach(function (who) {
          if (!nodes[who]) {
            nodes[who] = circle(PEOPLE[who][0], PEOPLE[who][1])
            nodes[who].className = 'is-new'

            window.setTimeout(
              (function (el) {
                return function () {
                  el.classList.remove('is-new')
                }
              })(nodes[who]),
              460,
            )
          }
          order.push(nodes[who])
        })

        var rest = inside.length - want.length
        if (rest > 0) {
          if (!chip) chip = circle('', '#374b9b')
          chip.textContent = '+' + rest
          order.push(chip)
        } else if (chip) {
          chip.remove()
          chip = null
        }

        order.forEach(function (el, i) {
          var at = room.children[i]
          if (at !== el) room.insertBefore(el, at || null)
        })

        var moved = []
        Array.prototype.forEach.call(room.children, function (el) {
          var was = before.get(el)
          if (was === undefined) return
          var dx = was - el.getBoundingClientRect().left
          if (!dx) return
          el.style.transition = 'none'
          el.style.transform = 'translateX(' + dx + 'px)'
          moved.push(el)
        })
        if (moved.length > 0) {
          void room.offsetWidth

          moved.forEach(function (el) {
            el.style.transition = ''
            el.style.transform = ''
          })
        }

        if (roomN) roomN.textContent = WORDS[inside.length] || String(inside.length)
      }

      var sayTimer = null
      var say = function (who, arriving) {
        if (!sayBox) return
        var one = PEOPLE[who]
        /* Род берётся из четвёртого поля строки списка, а не угадывается по
           имени: в английском словаре оба варианта одинаковы, и правило
           «вошла/вошёл» там просто не срабатывает. */
        var verb = (arriving ? S.joined : S.left)[one[3] ? 1 : 0]
        sayBox.textContent = one[2] + ' ' + verb
        sayBox.className = 'room-say is-on' + (arriving ? '' : ' is-gone')
        window.clearTimeout(sayTimer)
        sayTimer = window.setTimeout(function () {
          sayBox.classList.remove('is-on')
        }, 2600)
      }

      var tick = function () {
        var canLeave = inside.length > 8
        var canJoin = pool.length > 0 && inside.length < 15
        var leaving
        if (canLeave && canJoin) leaving = Math.random() < 0.45
        else if (canLeave) leaving = true
        else if (canJoin) leaving = false
        else return

        if (leaving) {
          var seat =
            Math.random() < 0.7
              ? Math.floor(Math.random() * Math.min(SEATS, inside.length))
              : Math.floor(Math.random() * inside.length)
          var out = inside.splice(seat, 1)[0]
          pool.push(out)
          render()
          say(out, false)
        } else {
          var span = pool.length > 1 ? pool.length - 1 : pool.length
          var back = pool.splice(Math.floor(Math.random() * span), 1)[0]
          var arrived = back

          inside.unshift(back)
          render()
          say(arrived, true)
        }
      }

      room.textContent = ''
      render()
      room.classList.add('is-in')
      window.setTimeout(function () {
        room.classList.remove('is-in')
      }, 1200)

      var timer = null

      var FIRST = 1400
      var first = true
      var schedule = function () {
        var wait = first ? FIRST : 5000 + Math.random() * 4500
        first = false
        timer = window.setTimeout(function () {
          tick()
          schedule()
        }, wait)
      }

      var rail = room.closest('.room-line') || room
      if ('IntersectionObserver' in window) {
        new IntersectionObserver(
          function (entries) {
            if (entries[0] && entries[0].isIntersecting) {
              if (!timer) schedule()
            } else if (timer) {
              window.clearTimeout(timer)
              timer = null
            }
          },
          { threshold: 0 },
        ).observe(rail)
      } else {
        schedule()
      }
    })()
  } catch (e) {}

  /* ------------------------------------------ чужие каретки в заголовке */
  try {
    ;(function () {
      if (reduce) return

      var fields = [
        { el: document.getElementById('hero-h'), crew: 2 },
        { el: document.getElementById('hero-p'), crew: 2 },
      ].filter(function (f) {
        return f.el
      })
      if (fields.length === 0) return

      var textNodes = function (el) {
        var out = []
        var walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
          acceptNode: function (node) {
            return node.parentElement && node.parentElement.closest('.cursors')
              ? NodeFilter.FILTER_REJECT
              : NodeFilter.FILTER_ACCEPT
          },
        })
        var node
        while ((node = walk.nextNode())) out.push(node)
        return out
      }

      var locate = function (nodes, i) {
        for (var k = 0; k < nodes.length; k += 1) {
          var len = nodes[k].nodeValue.length
          if (i < len || (i === len && k === nodes.length - 1)) return [nodes[k], i]
          i -= len
        }
        return null
      }

      var rangeFor = function (el, a, b) {
        var nodes = textNodes(el)
        var s = locate(nodes, a)
        var e = locate(nodes, b)
        if (!s || !e) return null
        var r = document.createRange()
        r.setStart(s[0], s[1])
        r.setEnd(e[0], e[1])
        return r
      }

      var fit = function (box, size) {
        var h = Math.min(box.height, size * 1.16)
        return { y: box.top + (box.height - h) / 2, h: h }
      }

      var caretAt = function (el, i, total, size) {
        var r = i < total ? rangeFor(el, i, i + 1) : rangeFor(el, Math.max(0, i - 1), i)
        if (!r) return null
        var box = r.getBoundingClientRect()
        if (!box.height) return null
        var v = fit(box, size)
        return { x: i < total ? box.left : box.right, y: v.y, h: v.h }
      }

      var wordsOf = function (el) {
        var text = textNodes(el)
          .map(function (n) {
            return n.nodeValue
          })
          .join('')
        var words = []
        var re = /[^\s]+/g
        var m
        while ((m = re.exec(text))) words.push([m.index, m.index + m[0].length])
        return { total: text.length, words: words }
      }

      var inkFor = function (hex) {
        var n = parseInt(hex.slice(1), 16)
        var r = (n >> 16) & 255
        var g = (n >> 8) & 255
        var b = n & 255
        return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#101a33' : '#ffffff'
      }

      var pick = function (n) {
        return Math.floor(Math.random() * n)
      }

      var actors = []

      var Actor = function (field, who) {
        var el = field.el
        var wrap = document.createElement('span')
        wrap.className = 'cur'
        wrap.style.setProperty('--tint', who[1])
        wrap.style.setProperty('--cur-ink', inkFor(who[1]))

        var sel = document.createElement('i')
        sel.className = 'cur-sel'
        var bar = document.createElement('i')
        bar.className = 'cur-bar'
        var tag = document.createElement('b')
        tag.className = 'cur-tag'
        tag.textContent = who[2]
        bar.appendChild(tag)
        wrap.appendChild(sel)
        wrap.appendChild(bar)
        field.layer.appendChild(wrap)

        var mark = { lo: 0, hi: 0, on: false }
        field.busy.push(mark)

        var at = 0
        var to = 0
        var here = false
        var timer = null
        var tagTimer = null

        var place = function (animate) {
          var w = wordsOf(el)
          var base = el.getBoundingClientRect()
          var size = parseFloat(window.getComputedStyle(el).fontSize) || 16
          var head = caretAt(el, to, w.total, size)
          if (!head) return

          bar.style.width = Math.max(2, Math.round(size / 22)) + 'px'
          if (!animate) bar.style.transition = 'none'
          bar.style.transform =
            'translate(' + (head.x - base.left) + 'px,' + (head.y - base.top) + 'px)'
          bar.style.height = head.h + 'px'
          if (!animate) {
            void bar.offsetWidth
            bar.style.transition = ''
          }

          sel.textContent = ''
          if (at !== to) {
            var r = rangeFor(el, Math.min(at, to), Math.max(at, to))
            if (r) {
              var rects = r.getClientRects()
              for (var i = 0; i < rects.length; i += 1) {
                var one = rects[i]
                if (!one.width || !one.height) continue

                var v = fit(one, size)
                var u = document.createElement('u')
                u.style.left = one.left - base.left + 'px'
                u.style.top = v.y - base.top + 'px'
                u.style.width = one.width + 'px'
                u.style.height = v.h + 'px'
                sel.appendChild(u)
              }
            }
          }
        }

        var name = function () {
          wrap.classList.add('is-say')
          window.clearTimeout(tagTimer)
          tagTimer = window.setTimeout(function () {
            wrap.classList.remove('is-say')
          }, 1500)
        }

        var show = function () {
          here = true
          mark.on = true
          wrap.classList.add('is-on')
        }
        var hide = function () {
          here = false
          mark.on = false
          wrap.classList.remove('is-on', 'is-say')
        }

        var goTo = function (a, b) {
          at = a
          to = b
          mark.lo = Math.min(a, b)
          mark.hi = Math.max(a, b)
          place(true)
        }

        var free = function (a, b) {
          var lo = Math.min(a, b)
          var hi = Math.max(a, b)
          for (var i = 0; i < field.busy.length; i += 1) {
            var o = field.busy[i]
            if (o === mark || !o.on) continue
            if (Math.min(hi, o.hi) >= Math.max(lo, o.lo) - 2) return false
          }
          return true
        }

        var choose = function (make) {
          for (var i = 0; i < 5; i += 1) {
            var pair = make()
            if (pair && free(pair[0], pair[1])) return pair
          }
          return null
        }

        var crawl = function (left, w) {
          if (left <= 0) {
            plan()
            return
          }
          var next = Math.max(0, Math.min(w.total, to + (crawl.dir || 1)))
          goTo(next, next)
          timer = window.setTimeout(function () {
            crawl(left - 1, w)
          }, 110)
        }

        var act = function () {
          var w = wordsOf(el)
          if (w.words.length === 0) return

          if (!here) {
            var spot = choose(function () {
              var word = w.words[pick(w.words.length)]
              return [word[0], word[0]]
            })
            if (!spot) {
              plan()
              return
            }
            at = to = spot[0]
            mark.lo = mark.hi = spot[0]
            place(false)
            show()
            name()
            plan()
            return
          }

          var roll = Math.random()
          if (roll < 0.14) {
            hide()
            plan()
            return
          }
          if (roll < 0.4) {
            var one = choose(function () {
              var word = w.words[pick(w.words.length)]
              return [word[0], word[1]]
            })
            if (one) {
              goTo(one[0], one[1])
              name()
            }
            plan()
            return
          }
          if (roll < 0.58) {
            var many = choose(function () {
              var from = pick(w.words.length)
              var span = Math.min(from + 1 + pick(3), w.words.length - 1)
              return [w.words[from][0], w.words[span][1]]
            })
            if (many) {
              goTo(many[0], many[1])
              name()
            }
            plan()
            return
          }
          if (roll < 0.78) {
            crawl.dir = Math.random() < 0.5 ? -1 : 1
            name()
            crawl(3 + pick(4), w)
            return
          }
          var solo = choose(function () {
            var word = w.words[pick(w.words.length)]
            return [word[0], word[0]]
          })
          if (solo) {
            goTo(solo[0], solo[0])
            name()
          }
          plan()
        }

        var plan = function () {
          window.clearTimeout(timer)
          timer = window.setTimeout(act, 1600 + Math.random() * 3400)
        }

        return {
          start: function () {
            if (!timer) timer = window.setTimeout(act, 400 + Math.random() * 2600)
          },
          stop: function () {
            window.clearTimeout(timer)
            timer = null
          },
          remeasure: function () {
            if (here) place(false)
          },
        }
      }

      var bag = ROSTER.slice()
      fields.forEach(function (field) {
        field.el.classList.add('live')
        var layer = document.createElement('span')
        layer.className = 'cursors'

        layer.setAttribute('aria-hidden', 'true')
        field.el.appendChild(layer)
        field.layer = layer

        field.busy = []
        for (var i = 0; i < field.crew; i += 1) {
          if (bag.length === 0) break
          actors.push(Actor(field, bag.splice(pick(bag.length), 1)[0]))
        }
      })

      var running = false
      var run = function (on) {
        if (on === running) return
        running = on
        actors.forEach(function (a) {
          if (on) a.start()
          else a.stop()
        })
      }

      if ('ResizeObserver' in window) {
        var settle = null
        var ro = new ResizeObserver(function () {
          window.clearTimeout(settle)
          settle = window.setTimeout(function () {
            actors.forEach(function (a) {
              a.remeasure()
            })
          }, 120)
        })
        fields.forEach(function (f) {
          ro.observe(f.el)
        })
      }

      var hero = fields[0].el.closest('.hero') || fields[0].el
      if ('IntersectionObserver' in window) {
        new IntersectionObserver(
          function (entries) {
            run(!!(entries[0] && entries[0].isIntersecting))
          },
          { threshold: 0 },
        ).observe(hero)
      } else {
        run(true)
      }
    })()
  } catch (e) {}

  /* ---------------------------------------------------------- дверь ---- */
  try {
    ;(function () {
      var door = document.getElementById('door')
      var nameBox = document.getElementById('door-name')
      var glyph = document.getElementById('door-glyph')
      var said = document.getElementById('door-said')
      var grid = document.getElementById('door-grid')
      var card = document.getElementById('door-card')
      var change = document.getElementById('door-change')
      var hint = document.getElementById('door-hint')
      var go = document.getElementById('door-go')
      var goText = document.getElementById('door-go-text')
      var goMark = document.getElementById('door-go-mark')
      var goArrow = document.getElementById('door-go-arrow')
      var goCheck = document.getElementById('door-go-check')
      var foot = document.getElementById('door-foot')
      var stack = document.getElementById('door-stack')
      var count = document.getElementById('door-count')
      var form = document.getElementById('door-form')

      if (door && nameBox && glyph && said && grid && go) {
        /* Ровно тот набор и в том же порядке, что в продукте: страница
           обещает «сорок меток» и должна показывать сорок, а не выборку
           из них — иначе первый же посетитель, который их пересчитает,
           поймает страницу на округлении. */
        var MARKS = S.marks
        /* Цвет круга в продукте чеканится из id участника; здесь его
           неоткуда взять, поэтому берётся ровно та палитра, которой
           подписаны люди в рейке героя. */
        var TINTS = ['#e8734a', '#8b6bd9', '#2fa36b', '#e3a72f', '#0fa0d7', '#3ec9a7']
        /* Имена в поле — те же, что у людей в рейке героя. */
        var NAMES = S.names

        var markAt = 0
        var mine = null /* метка, выбранная читателем */
        var typing = !reduce /* набирает ли страница */
        var joined = false
        var timer = null
        var wake = null

        var setMark = function (i, animate) {
          markAt = i
          glyph.textContent = MARKS[i][0]
          glyph.style.background = TINTS[i % TINTS.length]
          /* «Теперь вы — X», а не «вам досталась X»: сорок меток разного
             рода, и любая фраза с согласованием требует таблицы родов
             ради одной строки. Здесь род не нужен ни одной из них. */
          said.textContent = S.markLead + MARKS[i][1]
          if (animate && !reduce) {
            glyph.classList.remove('is-swap')
            /* Перезапуск анимации: без чтения offsetWidth браузер
               склеивает снятие и возврат класса в один кадр. */
            void glyph.offsetWidth
            glyph.classList.add('is-swap')
          }
          var buttons = grid.children
          for (var k = 0; k < buttons.length; k += 1) {
            buttons[k].setAttribute('aria-pressed', k === i ? 'true' : 'false')
          }
        }

        /* -------------------------------------------------- сетка меток */
        for (var i = 0; i < MARKS.length; i += 1) {
          ;(function (idx) {
            var b = document.createElement('button')
            b.type = 'button'
            b.textContent = MARKS[idx][0]
            b.title = MARKS[idx][1]
            b.setAttribute('aria-label', MARKS[idx][1])
            b.setAttribute('aria-pressed', 'false')
            b.addEventListener('click', function () {
              mine = idx
              setMark(idx, true)
              closeGrid(true)
            })
            grid.appendChild(b)
          })(i)
        }

        /*
         * Открытие сетки — смена режима, а не показ ещё одного блока:
         * карточка уходит, и вместе с ней уходит кнопка, на которой
         * стоял фокус. Поэтому фокус переезжает на выбранную метку —
         * иначе он падает на body, и клавиатура остаётся посреди
         * страницы без места, откуда продолжать.
         */
        var openGrid = function () {
          if (card) card.hidden = true
          grid.hidden = false
          if (change) change.setAttribute('aria-expanded', 'true')
          if (hint) {
            hint.hidden = false
            hint.textContent = S.markCount(MARKS.length)
          }
          var here = grid.children[mine === null ? markAt : mine]
          if (here) here.focus()
        }
        var closeGrid = function (back) {
          grid.hidden = true
          if (card) card.hidden = false
          if (change) change.setAttribute('aria-expanded', 'false')
          if (hint) hint.hidden = true
          if (back && change) change.focus()
        }
        if (change) change.addEventListener('click', openGrid)
        /*
         * Escape слушает форма, а не сетка. Мышью «Другую» нажимают без
         * фокуса, и обработчик на сетке в этом случае не получает
         * события вовсе — то есть режим, открытый мышью, закрыть с
         * клавиатуры было нельзя.
         */
        form.addEventListener('keydown', function (e) {
          if (e.key === 'Escape' && !grid.hidden) {
            e.preventDefault()
            closeGrid(true)
          }
        })

        /* ------------------------------------------------- набор имени */
        var stop = function () {
          typing = false
          if (timer) {
            window.clearTimeout(timer)
            timer = null
          }
        }

        /*
         * Первое касание поля. `once: true` — не оптимизация: обработчик
         * очищает поле, и оставить его висеть значило бы стирать имя при
         * каждом возврате фокуса.
         */
        var mineNow = function () {
          if (!typing) return
          stop()
          nameBox.value = ''
          enable()
        }
        ;['focus', 'keydown', 'pointerdown'].forEach(function (ev) {
          nameBox.addEventListener(ev, mineNow, { once: true })
        })
        /* Набор мог быть выключен заранее (reduced motion) — тогда поле
           уже пустое и обычное, и трогать нечего. */

        var enable = function () {
          go.disabled = !nameBox.value.trim() && !joined
        }
        nameBox.addEventListener('input', function () {
          /* Печатать в поле после входа — это и есть «войти другим»:
             форма возвращается, но набранная буква остаётся, иначе
             клавиша просто пропала бы. */
          if (joined) reset(true)
          enable()
        })

        var word = 0
        var pos = 0
        var erasing = false
        var step = function () {
          if (!typing) return
          var text = NAMES[word]
          if (!erasing) {
            pos += 1
            nameBox.value = text.slice(0, pos)
            enable()
            if (pos >= text.length) {
              erasing = true
              /* Имя дописано — столько оно и стоит: меньше секунды с
                 половиной читатель не успевает понять, что это имя, а не
                 набор букв. */
              timer = window.setTimeout(step, 1900)
              return
            }
            /* 105ms на букву — это человек, печатающий своё имя. */
            timer = window.setTimeout(step, 105)
            return
          }
          pos -= 1
          nameBox.value = text.slice(0, pos)
          enable()
          if (pos <= 0) {
            erasing = false
            word = (word + 1) % NAMES.length
            /* Ушёл один человек — ушла и его метка. Свою читатель уже
               выбрал, и её перебор не трогает. */
            if (mine === null) setMark((markAt + 1) % MARKS.length, true)
            timer = window.setTimeout(step, 520)
            return
          }
          timer = window.setTimeout(step, 42)
        }

        /* ---------------------------------------------------- нажатие */
        /*
         * Сколько человек в комнате — не то же самое, сколько кругов на
         * афише: продукт рисует первые четыре, а число называет полное.
         *
         * Число лежит в `data-n` рядом со строкой, а не вычитывается из
         * неё: строка начинается со слова, и `parseInt` на ней давал NaN,
         * то есть ноль мест — вошедший читатель видел «внутри уже 1
         * человек» при пяти кругах, а вышедший «внутри уже 0».
         */
        var seats = count ? parseInt(count.getAttribute('data-n'), 10) || 0 : 0
        var seated = null
        form.addEventListener('submit', function (e) {
          e.preventDefault()
          var who = nameBox.value.trim()
          if (!who || joined) return
          stop()
          joined = true

          if (stack && !seated) {
            seated = document.createElement('span')
            seated.className = 'is-new is-me'
            seated.style.background = TINTS[markAt % TINTS.length]
            seated.textContent = MARKS[markAt][0]
            /* Первым, а не последним: в хвосте круг ложится под соседей
               и от него остаётся серп без метки — то есть человек,
               который вошёл и которого не видно. */
            stack.insertBefore(seated, stack.firstChild)
          }
          if (count) {
            count.textContent = S.inside(seats + 1)
          }
          if (goMark) {
            goMark.hidden = false
            goMark.textContent = MARKS[markAt][0]
          }
          if (goArrow) goArrow.style.display = 'none'
          if (goCheck) goCheck.hidden = false
          if (goText) goText.textContent = S.entered(who)
          if (foot) {
            foot.textContent = ''
            var again = document.createElement('button')
            again.type = 'button'
            again.className = 'door-again'
            again.textContent = S.again
            again.addEventListener('click', function () {
              reset()
              nameBox.focus()
            })
            /* Единственная строка внутри рамки, которой продукт не
               говорит: это говорит страница о себе. */
            foot.appendChild(document.createTextNode(S.exampleLead))
            foot.appendChild(again)
          }
        })

        var reset = function (keepName) {
          if (!joined) return
          joined = false
          if (seated) {
            seated.remove()
            seated = null
          }
          if (count) count.textContent = S.inside(seats)
          if (goMark) goMark.hidden = true
          if (goCheck) goCheck.hidden = true
          if (goArrow) goArrow.style.display = ''
          if (goText) goText.textContent = S.enter
          if (foot) {
            foot.textContent = S.doorFoot
          }
          if (!keepName) nameBox.value = ''
          enable()
        }

        /* --------------------------------------------------- завод */
        setMark(0, false)
        if (!typing) {
          /* Движение запрещено: поле стоит заполненным — это конечный
             кадр той же сцены, и он осмысленный сам по себе. */
          nameBox.value = NAMES[0]
        }
        enable()

        /* Набор идёт, только пока дверь на экране. Ставится и снимается,
           а не запускается однажды: страница длинная, и печатать в поле,
           которого никто не видит, — это греть процессор. */
        if (typing && 'IntersectionObserver' in window) {
          wake = new IntersectionObserver(
            function (entries) {
              if (!typing) return
              if (entries[0] && entries[0].isIntersecting) {
                if (!timer) timer = window.setTimeout(step, 400)
              } else if (timer) {
                window.clearTimeout(timer)
                timer = null
              }
            },
            { threshold: 0.25 },
          )
          wake.observe(door)
        } else if (typing) {
          timer = window.setTimeout(step, 400)
        }
      }
    })()
  } catch (e) {}

  /* --------------------------------------------- живая ячейка -------- */
  try {
    var kernel = document.querySelector('.kernel')
    if (kernel) {
      var cells = Array.prototype.slice.call(kernel.querySelectorAll('.cell'))
      var hint = kernel.querySelector('.kernel-hint')
      /* 380ms: это не длительность анимации, а выдуманная задержка, и
         читатель уже нажал и ждёт. In [*] успевает прочитаться, а
         ощущение медленного продукта ещё не появляется. */
      var RUN_MS = 380
      var busy = null
      var queued = null
      var hasDf = false
      var count = 0

      /* Подмена реплики разведена во времени, как в .swhat: старая уходит
         за 120ms, новая приходит за 160ms с задержкой в 100ms. Коробка под
         две строки зарезервирована в CSS, поэтому шапка ядра больше не
         толкает ячейки вниз в момент смены текста. */
      var hintTimer = 0
      var say = function (text) {
        if (!hint) return
        hint.classList.add('is-out')
        window.clearTimeout(hintTimer)
        hintTimer = window.setTimeout(function () {
          hint.textContent = text
          hint.classList.remove('is-out')
        }, 120)
      }
      var out = function (cell, text) {
        cell.querySelector('.cell-out p').textContent = text
      }
      var prompt = function (cell, text) {
        cell.querySelector('.cell-prompt').textContent = text
      }

      var finish = function (cell) {
        count += 1
        prompt(cell, 'In [' + count + ']')

        if (cell.getAttribute('data-owner') === 'maria') {
          hasDf = true
          cell.setAttribute('data-run', 'done')
          out(cell, '(1000, 14)')
          var you = cells[1]
          if (you && you.getAttribute('data-run') === 'error') {
            /* Ошибка снимается сама: переменная появилась в том же
               ядре, и держать чужой NameError на экране больше незачем. */
            you.setAttribute('data-run', 'idle')
            prompt(you, 'In [ ]')
            window.setTimeout(function () {
              if (you.getAttribute('data-run') === 'idle') out(you, '')
            }, 160)
            say(S.kernelFixed)
          } else {
            say(S.kernelLoaded)
          }
          return
        }

        if (hasDf) {
          cell.setAttribute('data-run', 'done')
          out(cell, '0.3187')
          say(S.kernelShared)
        } else {
          cell.setAttribute('data-run', 'error')
          out(cell, "NameError: name 'df' is not defined")
          say(S.kernelMissing)
        }
      }

      var start = function (cell) {
        busy = cell
        cell.setAttribute('data-run', 'running')
        prompt(cell, 'In [*]')
        /* Прошлый вывод стирается после того, как строка выцвела, а не в
           тот же кадр: уход .cell-out p занимает 160ms. Гард на состояние —
           чтобы не стереть результат, если он уже пришёл. */
        window.setTimeout(function () {
          if (cell.getAttribute('data-run') === 'running') out(cell, '')
        }, 160)
        var btn = cell.querySelector('.cell-run')
        btn.setAttribute('aria-busy', 'true')
        window.setTimeout(function () {
          btn.removeAttribute('aria-busy')
          busy = null
          finish(cell)
          var next = queued
          queued = null
          if (next) start(next)
        }, RUN_MS)
      }

      var press = function (cell) {
        if (busy === cell || queued === cell) return
        if (busy) {
          /* Очередь возникает естественным жестом: нажали вторую ячейку,
             пока идёт первая. Ровно то, что написано в соседней плитке
             про общий терминал, — команды двоих встают в очередь. */
          queued = cell
          cell.setAttribute('data-run', 'queued')
          out(cell, S.kernelQueuedOut)
          say(S.kernelQueued)
          return
        }
        start(cell)
      }

      cells.forEach(function (cell) {
        var btn = cell.querySelector('.cell-run')
        if (!btn) return
        btn.addEventListener('click', function () {
          press(cell)
        })
        /* Shift+Enter — идиома Jupyter, и она сама по себе объясняет,
           что перед вами ноутбук, а не картинка ноутбука. */
        cell.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && e.shiftKey) {
            e.preventDefault()
            press(cell)
          }
        })
      })
    }
  } catch (e) {}
})()
