/*
 * Live pieces of the landing page: the presence rail in the hero, other
 * people's carets in the heading, the entry screen and two cells of one
 * kernel.
 *
 * The script is shared by the Russian and the English page. Everything that
 * depends on the language (names, number words, forty labels, the kernel's
 * lines) the page puts into window.COLLOQ_I18N before including this file.
 * Keeping two copies of a thousand lines for the sake of "joined" in two
 * languages is not an option: they would diverge on the very first day, and
 * diverge silently.
 */
;(function () {
  'use strict'

  /*
   * An explicit language choice. A click on a label in the header is
   * remembered, and from then on the auto-detection in <head> stays quiet:
   * a person who once said "Russian for me" should not have to say it on
   * every tab.
   *
   * The write happens synchronously in the handler, before the browser
   * follows the link, so no separate preventDefault is needed. The block
   * stands before the dictionary check: the switch must work even on a page
   * that has no live demos at all.
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
  /* No dictionary, nothing to show: the demo consists entirely of its strings. */
  if (!S) return

  var reduce = false
  try {
    reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch (e) {}

  var ROSTER = S.roster

  /* ------------------------------------------- presence rail in the hero */
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
        /* The gender comes from the fourth field of the roster row, not
           guessed from the name: in the English dictionary both variants are
           the same, and the Russian rule of a feminine or masculine "joined"
           simply does not apply there. */
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

  /* ------------------------------- other people's carets in the heading */
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

  /* ------------------------------------------------ live cell -------- */
  try {
    var kernel = document.querySelector('.kernel')
    if (kernel) {
      var cells = Array.prototype.slice.call(kernel.querySelectorAll('.cell'))
      var hint = kernel.querySelector('.kernel-hint')
      /* 380ms: this is not an animation duration but an invented delay, and
         the reader has already pressed and is waiting. In [*] has time to be
         read, while the feeling of a slow product does not set in yet. */
      var RUN_MS = 380
      var busy = null
      var queued = null
      var hasDf = false
      var count = 0

      /* The line swap is spread out in time, as in .swhat: the old one
         leaves in 120ms, the new one arrives in 160ms with a 100ms delay. A
         box for two lines is reserved in CSS, so the kernel header no longer
         pushes the cells down at the moment the text changes. */
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
            /* The error clears itself: the variable appeared in the same
               kernel, and there is no reason to keep someone else's NameError
               on screen any more. */
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
        /* The previous output is erased after the line has faded, not in the
           same frame: .cell-out p takes 160ms to leave. The guard on state is
           there so as not to erase the result if it has already arrived. */
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
          /* The queue arises from a natural gesture: the second cell was
             pressed while the first one is running. Exactly what the
             neighbouring tile says about the shared terminal: the commands of
             two people get queued. */
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
        /* Shift+Enter is a Jupyter idiom, and by itself it explains that
           what you see is a notebook, not a picture of a notebook. */
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
