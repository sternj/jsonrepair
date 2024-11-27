import { JSONRepairError } from '../utils/JSONRepairError.js'
import {
  codeAsterisk,
  codeBackslash,
  codeCloseParenthesis,
  codeClosingBrace,
  codeClosingBracket,
  codeColon,
  codeComma,
  codeDot,
  codeDoubleQuote,
  codeLowercaseE,
  codeMinus,
  codeNewline,
  codeOpenParenthesis,
  codeOpeningBrace,
  codeOpeningBracket,
  codePlus,
  codeSemicolon,
  codeSlash,
  codeUppercaseE,
  isControlCharacter,
  isDelimiter,
  isDigit,
  isDoubleQuote,
  isDoubleQuoteLike,
  isHex,
  isQuote,
  isSingleQuote,
  isSingleQuoteLike,
  isSpecialWhitespace,
  isStartOfValue,
  isUnquotedStringDelimiter,
  isValidStringCharacter,
  isWhitespace,
  regexFunctionNameChar,
  regexFunctionNameCharStart,
  regexUrlChar,
  regexUrlStart
} from '../utils/stringUtils.js'
import { createInputBuffer } from './buffer/InputBuffer.js'
import { createOutputBuffer } from './buffer/OutputBuffer.js'
import { Caret, StackType, createStack } from './stack.js'

const controlCharacters: { [key: string]: string } = {
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t'
}

// map with all escape characters
const escapeCharacters: { [key: string]: string } = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t'
  // note that \u is handled separately in parseString()
}

export interface JsonRepairCoreOptions {
  onData: (chunk: string) => void
  chunkSize?: number
  bufferSize?: number
}

export interface JsonRepairCore {
  transform: (chunk: string) => void
  flush: () => void
}

export function jsonrepairCore({
  onData,
  bufferSize = 65536,
  chunkSize = 65536
}: JsonRepairCoreOptions): JsonRepairCore {
  const input = createInputBuffer()

  const output = createOutputBuffer({
    write: onData,
    bufferSize,
    chunkSize
  })

  let i = 0
  let iFlushed = 0
  const stack = createStack()

  function flushInputBuffer() {
    while (iFlushed < i - bufferSize - chunkSize) {
      iFlushed += chunkSize
      input.flush(iFlushed)
    }
  }

  function transform(chunk: string) {
    input.push(chunk)

    while (i < input.currentLength() - bufferSize && parse()) {
      // loop until there is nothing more to process
    }

    flushInputBuffer()
  }

  function flush() {
    input.close()

    while (parse()) {
      // loop until there is nothing more to process
    }

    output.flush()
  }

  function parse(): boolean {
    parseWhitespaceAndSkipComments()

    switch (stack.type) {
      case StackType.object: {
        switch (stack.caret) {
          case Caret.beforeKey:
            return (
              skipEllipsis() ||
              parseObjectKey() ||
              parseUnexpectedColon() ||
              parseRepairTrailingComma() ||
              parseRepairObjectEndOrComma()
            )
          case Caret.beforeValue:
            return parseValue() || parseRepairMissingObjectValue()
          case Caret.afterValue:
            return parseObjectComma() || parseObjectEnd() || parseRepairObjectEndOrComma()
          default:
            return false
        }
      }

      case StackType.array: {
        switch (stack.caret) {
          case Caret.beforeValue:
            return (
              skipEllipsis() || parseValue() || parseRepairTrailingComma() || parseRepairArrayEnd()
            )
          case Caret.afterValue:
            return (
              parseArrayComma() ||
              parseArrayEnd() ||
              parseRepairMissingComma() ||
              parseRepairArrayEnd()
            )
          default:
            return false
        }
      }

      case StackType.ndJson: {
        switch (stack.caret) {
          case Caret.beforeValue:
            return parseValue() || parseRepairTrailingComma()
          case Caret.afterValue:
            return parseArrayComma() || parseRepairMissingComma() || parseRepairNdJsonEnd()
          default:
            return false
        }
      }

      case StackType.functionCall: {
        switch (stack.caret) {
          case Caret.beforeValue:
            return parseValue()
          case Caret.afterValue:
            return parseFunctionCallEnd()
          default:
            return false
        }
      }

      case StackType.root: {
        switch (stack.caret) {
          case Caret.beforeValue:
            return parseValue() || parseUnexpectedEnd()
          case Caret.afterValue:
            return parseRootEnd()
          default:
            return false
        }
      }

      default:
        return false
    }
  }

  function parseValue(): boolean {
    return (
      parseObjectStart() ||
      parseArrayStart() ||
      parseString() ||
      parseNumber() ||
      parseKeywords() ||
      parseRepairUnquotedString() ||
      parseRepairRegex()
    )
  }

  function parseObjectStart(): boolean {
    if (parseCharacter(codeOpeningBrace)) {
      parseWhitespaceAndSkipComments()

      skipEllipsis()

      if (skipCharacter(codeComma)) {
        parseWhitespaceAndSkipComments()
      }

      if (parseCharacter(codeClosingBrace)) {
        return stack.update(Caret.afterValue)
      }

      return stack.push(StackType.object, Caret.beforeKey)
    }

    return false
  }

  function parseArrayStart(): boolean {
    if (parseCharacter(codeOpeningBracket)) {
      parseWhitespaceAndSkipComments()

      skipEllipsis()

      if (skipCharacter(codeComma)) {
        parseWhitespaceAndSkipComments()
      }

      if (parseCharacter(codeClosingBracket)) {
        return stack.update(Caret.afterValue)
      }

      return stack.push(StackType.array, Caret.beforeValue)
    }

    return false
  }

  function parseRepairUnquotedString(): boolean {
    let j = i

    if (regexFunctionNameCharStart.test(input.charAt(j))) {
      while (!input.isEnd(j) && regexFunctionNameChar.test(input.charAt(j))) {
        j++
      }

      let k = j
      while (isWhitespace(input.charCodeAt(k))) {
        k++
      }

      if (input.charCodeAt(k) === codeOpenParenthesis) {
        // repair a MongoDB function call like NumberLong("2")
        // repair a JSONP function call like callback({...});
        k++
        i = k
        return stack.push(StackType.functionCall, Caret.beforeValue)
      }
    }

    j = findNextDelimiter(false, j)
    if (j !== null) {
      // test start of an url like "https://..." (this would be parsed as a comment)
      if (input.charCodeAt(j - 1) === codeColon && regexUrlStart.test(input.substring(i, j + 2))) {
        while (!input.isEnd(j) && regexUrlChar.test(input.charAt(j))) {
          j++
        }
      }

      const symbol = input.substring(i, j)
      i = j

      output.push(symbol === 'undefined' ? 'null' : JSON.stringify(symbol))

      if (input.charCodeAt(i) === codeDoubleQuote) {
        // we had a missing start quote, but now we encountered the end quote, so we can skip that one
        i++
      }

      return stack.update(Caret.afterValue)
    }

    return false
  }

  function parseRepairRegex() {
    if (input.charAt(i) === '/') {
      const start = i
      i++

      while (!input.isEnd(i) && (input.charAt(i) !== '/' || input.charAt(i - 1) === '\\')) {
        i++
      }
      i++

      output.push(`"${input.substring(start, i)}"`)

      return stack.update(Caret.afterValue)
    }
  }

  function parseRepairMissingObjectValue(): boolean {
    // repair missing object value
    output.push('null')
    return stack.update(Caret.afterValue)
  }

  function parseRepairTrailingComma(): boolean {
    // repair trailing comma
    if (output.endsWithIgnoringWhitespace(',')) {
      output.stripLastOccurrence(',')
      return stack.update(Caret.afterValue)
    }

    return false
  }

  function parseUnexpectedColon(): boolean {
    if (input.charCodeAt(i) === codeColon) {
      throwObjectKeyExpected()
    }

    return false
  }

  function parseUnexpectedEnd(): boolean {
    if (input.isEnd(i)) {
      throwUnexpectedEnd()
    } else {
      throwUnexpectedCharacter()
    }

    return false
  }

  function parseObjectKey(): boolean {
    const parsedKey = parseString() || parseUnquotedKey()
    if (parsedKey) {
      parseWhitespaceAndSkipComments()

      if (parseCharacter(codeColon)) {
        // expect a value after the :
        return stack.update(Caret.beforeValue)
      }

      const truncatedText = input.isEnd(i)
      if (isStartOfValue(input.charAt(i)) || truncatedText) {
        // repair missing colon
        output.insertBeforeLastWhitespace(':')
        return stack.update(Caret.beforeValue)
      }

      throwColonExpected()
    }

    return false
  }

  function parseObjectComma(): boolean {
    if (parseCharacter(codeComma)) {
      return stack.update(Caret.beforeKey)
    }

    return false
  }

  function parseObjectEnd(): boolean {
    if (parseCharacter(codeClosingBrace)) {
      return stack.pop()
    }

    return false
  }

  function parseRepairObjectEndOrComma(): true {
    // repair missing object end and trailing comma
    if (input.charAt(i) === '{') {
      output.stripLastOccurrence(',')
      output.insertBeforeLastWhitespace('}')
      return stack.pop()
    }

    // repair missing comma
    if (!input.isEnd(i) && isStartOfValue(input.charAt(i))) {
      output.insertBeforeLastWhitespace(',')
      return stack.update(Caret.beforeKey)
    }

    // repair missing closing brace
    output.insertBeforeLastWhitespace('}')
    return stack.pop()
  }

  function parseArrayComma(): boolean {
    if (parseCharacter(codeComma)) {
      return stack.update(Caret.beforeValue)
    }

    return false
  }

  function parseArrayEnd(): boolean {
    if (parseCharacter(codeClosingBracket)) {
      return stack.pop()
    }

    return false
  }

  function parseRepairMissingComma(): boolean {
    // repair missing comma
    if (!input.isEnd(i) && isStartOfValue(input.charAt(i))) {
      output.insertBeforeLastWhitespace(',')
      return stack.update(Caret.beforeValue)
    }

    return false
  }

  function parseRepairArrayEnd(): true {
    // repair missing closing bracket
    output.insertBeforeLastWhitespace(']')
    return stack.pop()
  }

  function parseRepairNdJsonEnd(): boolean {
    if (input.isEnd(i)) {
      output.push('\n]')
      return stack.pop()
    }

    throwUnexpectedEnd()
    return false // just to make TS happy
  }

  function parseFunctionCallEnd(): true {
    if (skipCharacter(codeCloseParenthesis)) {
      skipCharacter(codeSemicolon)
    }

    return stack.pop()
  }

  function parseRootEnd(): boolean {
    const parsedComma = parseCharacter(codeComma)
    parseWhitespaceAndSkipComments()

    if (
      isStartOfValue(input.charAt(i)) &&
      (output.endsWithIgnoringWhitespace(',') || output.endsWithIgnoringWhitespace('\n'))
    ) {
      // start of a new value after end of the root level object: looks like
      // newline delimited JSON -> turn into a root level array
      if (!parsedComma) {
        // repair missing comma
        output.insertBeforeLastWhitespace(',')
      }

      output.unshift('[\n')

      return stack.push(StackType.ndJson, Caret.beforeValue)
    }

    if (parsedComma) {
      // repair: remove trailing comma
      output.stripLastOccurrence(',')

      return stack.update(Caret.afterValue)
    }

    // repair redundant end braces and brackets
    while (input.charCodeAt(i) === codeClosingBrace || input.charCodeAt(i) === codeClosingBracket) {
      i++
      parseWhitespaceAndSkipComments()
    }

    if (!input.isEnd(i)) {
      throwUnexpectedCharacter()
    }

    return false
  }

  function parseWhitespaceAndSkipComments(): boolean {
    const start = i

    let changed = parseWhitespace()
    do {
      changed = parseComment()
      if (changed) {
        changed = parseWhitespace()
      }
    } while (changed)

    return i > start
  }

  function parseWhitespace(): boolean {
    let whitespace = ''
    let normal: boolean
    while (
      // biome-ignore lint/suspicious/noAssignInExpressions: <explanation>
      (normal = isWhitespace(input.charCodeAt(i))) ||
      isSpecialWhitespace(input.charCodeAt(i))
    ) {
      if (normal) {
        whitespace += input.charAt(i)
      } else {
        // repair special whitespace
        whitespace += ' '
      }

      i++
    }

    if (whitespace.length > 0) {
      output.push(whitespace)
      return true
    }

    return false
  }

  function parseComment(): boolean {
    // find a block comment '/* ... */'
    if (input.charCodeAt(i) === codeSlash && input.charCodeAt(i + 1) === codeAsterisk) {
      // repair block comment by skipping it
      while (!input.isEnd(i) && !atEndOfBlockComment(i)) {
        i++
      }
      i += 2

      return true
    }

    // find a line comment '// ...'
    if (input.charCodeAt(i) === codeSlash && input.charCodeAt(i + 1) === codeSlash) {
      // repair line comment by skipping it
      while (!input.isEnd(i) && input.charCodeAt(i) !== codeNewline) {
        i++
      }

      return true
    }

    return false
  }

  function parseCharacter(code: number): boolean {
    if (input.charCodeAt(i) === code) {
      output.push(input.charAt(i))
      i++
      return true
    }

    return false
  }

  function skipCharacter(code: number): boolean {
    if (input.charCodeAt(i) === code) {
      i++
      return true
    }

    return false
  }

  function skipEscapeCharacter(): boolean {
    return skipCharacter(codeBackslash)
  }

  /**
   * Skip ellipsis like "[1,2,3,...]" or "[1,2,3,...,9]" or "[...,7,8,9]"
   * or a similar construct in objects.
   */
  function skipEllipsis(): boolean {
    parseWhitespaceAndSkipComments()

    if (
      input.charCodeAt(i) === codeDot &&
      input.charCodeAt(i + 1) === codeDot &&
      input.charCodeAt(i + 2) === codeDot
    ) {
      // repair: remove the ellipsis (three dots) and optionally a comma
      i += 3
      parseWhitespaceAndSkipComments()
      skipCharacter(codeComma)

      return true
    }

    return false
  }

  /**
   * Parse a string enclosed by double quotes "...". Can contain escaped quotes
   * Repair strings enclosed in single quotes or special quotes
   * Repair an escaped string
   *
   * The function can run in two stages:
   * - First, it assumes the string has a valid end quote
   * - If it turns out that the string does not have a valid end quote followed
   *   by a delimiter (which should be the case), the function runs again in a
   *   more conservative way, stopping the string at the first next delimiter
   *   and fixing the string by inserting a quote there, or stopping at a
   *   stop index detected in the first iteration.
   */
  function parseString(stopAtDelimiter = false, stopAtIndex = -1): boolean {
    let skipEscapeChars = input.charCodeAt(i) === codeBackslash
    if (skipEscapeChars) {
      // repair: remove the first escape character
      i++
      skipEscapeChars = true
    }

    if (isQuote(input.charCodeAt(i))) {
      // double quotes are correct JSON,
      // single quotes come from JavaScript for example, we assume it will have a correct single end quote too
      // otherwise, we will match any double-quote-like start with a double-quote-like end,
      // or any single-quote-like start with a single-quote-like end
      const isEndQuote = isDoubleQuote(input.charCodeAt(i))
        ? isDoubleQuote
        : isSingleQuote(input.charCodeAt(i))
          ? isSingleQuote
          : isSingleQuoteLike(input.charCodeAt(i))
            ? isSingleQuoteLike
            : isDoubleQuoteLike

      const iBefore = i
      const oBefore = output.length()

      output.push('"')
      i++

      while (true) {
        if (input.isEnd(i)) {
          // end of text, we have a missing quote somewhere

          const iPrev = prevNonWhitespaceIndex(i - 1)
          if (!stopAtDelimiter && isDelimiter(input.charAt(iPrev))) {
            // if the text ends with a delimiter, like ["hello],
            // so the missing end quote should be inserted before this delimiter
            // retry parsing the string, stopping at the first next delimiter
            i = iBefore
            output.remove(oBefore)

            return parseString(true)
          }

          // repair missing quote
          output.insertBeforeLastWhitespace('"')

          return stack.update(Caret.afterValue)
          // biome-ignore lint/style/noUselessElse: <explanation>
        } else if (i === stopAtIndex) {
          // use the stop index detected in the first iteration, and repair end quote
          output.insertBeforeLastWhitespace('"')

          return stack.update(Caret.afterValue)
          // biome-ignore lint/style/noUselessElse: <explanation>
        } else if (isEndQuote(input.charCodeAt(i))) {
          // end quote
          // let us check what is before and after the quote to verify whether this is a legit end quote
          const iQuote = i
          const oQuote = output.length()
          output.push('"')
          i++

          parseWhitespaceAndSkipComments()

          if (
            stopAtDelimiter ||
            input.isEnd(i) ||
            isDelimiter(input.charAt(i)) ||
            isQuote(input.charCodeAt(i)) ||
            isDigit(input.charCodeAt(i))
          ) {
            // The quote is followed by the end of the text, a delimiter, or a next value
            // so the quote is indeed the end of the string
            parseConcatenatedString()

            return stack.update(Caret.afterValue)
          }

          const iPrevChar = prevNonWhitespaceIndex(iQuote - 1)
          const prevChar = input.charAt(iPrevChar)

          if (prevChar === ',') {
            // A comma followed by a quote, like '{"a":"b,c,"d":"e"}'.
            // We assume that the quote is a start quote, and that the end quote
            // should have been located right before the comma but is missing.
            i = iBefore
            output.remove(oBefore)

            return parseString(false, iPrevChar)
          }

          if (isDelimiter(prevChar)) {
            // This is not the right end quote: it is preceded by a delimiter,
            // and NOT followed by a delimiter. So, there is an end quote missing
            // parse the string again and then stop at the first next delimiter
            i = iBefore
            output.remove(oBefore)

            return parseString(true)
          }

          // revert to right after the quote but before any whitespace, and continue parsing the string
          output.remove(oQuote + 1)
          i = iQuote + 1

          // repair unescaped quote
          output.insertAt(oQuote, '\\')
        } else if (stopAtDelimiter && isUnquotedStringDelimiter(input.charAt(i))) {
          // we're in the mode to stop the string at the first delimiter
          // because there is an end quote missing

          // test start of an url like "https://..." (this would be parsed as a comment)
          if (
            input.charCodeAt(i - 1) === codeColon &&
            regexUrlStart.test(input.substring(iBefore + 1, i + 2))
          ) {
            while (!input.isEnd(i) && regexUrlChar.test(input.charAt(i))) {
              output.push(input.charAt(i))
              i++
            }
          }

          // repair missing quote
          output.insertBeforeLastWhitespace('"')

          parseConcatenatedString()

          return stack.update(Caret.afterValue)
        } else if (input.charCodeAt(i) === codeBackslash) {
          // handle escaped content like \n or \u2605
          const char = input.charAt(i + 1)
          const escapeChar = escapeCharacters[char]
          if (escapeChar !== undefined) {
            output.push(input.substring(i, i + 2))
            i += 2
          } else if (char === 'u') {
            let j = 2
            while (j < 6 && isHex(input.charCodeAt(i + j))) {
              j++
            }

            if (j === 6) {
              output.push(input.substring(i, i + 6))
              i += 6
            } else if (input.isEnd(i + j)) {
              // repair invalid or truncated unicode char at the end of the text
              // by removing the unicode char and ending the string here
              i += j
            } else {
              throwInvalidUnicodeCharacter()
            }
          } else {
            // repair invalid escape character: remove it
            output.push(char)
            i += 2
          }
        } else {
          // handle regular characters
          const char = input.charAt(i)
          const code = char.charCodeAt(0)

          if (code === codeDoubleQuote && input.charCodeAt(i - 1) !== codeBackslash) {
            // repair unescaped double quote
            output.push(`\\${char}`)
            i++
          } else if (isControlCharacter(code)) {
            // unescaped control character
            output.push(controlCharacters[char])
            i++
          } else {
            if (!isValidStringCharacter(code)) {
              throwInvalidCharacter(char)
            }
            output.push(char)
            i++
          }
        }

        if (skipEscapeChars) {
          // repair: skipped escape character (nothing to do)
          skipEscapeCharacter()
        }
      }
    }

    return false
  }

  /**
   * Repair concatenated strings like "hello" + "world", change this into "helloworld"
   */
  function parseConcatenatedString(): boolean {
    let parsed = false

    parseWhitespaceAndSkipComments()
    while (input.charCodeAt(i) === codePlus) {
      parsed = true
      i++
      parseWhitespaceAndSkipComments()

      // repair: remove the end quote of the first string
      output.stripLastOccurrence('"', true)
      const start = output.length()
      const parsedStr = parseString()
      if (parsedStr) {
        // repair: remove the start quote of the second string
        output.remove(start, start + 1)
      } else {
        // repair: remove the + because it is not followed by a string
        output.insertBeforeLastWhitespace('"')
      }
    }

    return parsed
  }

  /**
   * Parse a number like 2.4 or 2.4e6
   */
  function parseNumber(): boolean {
    const start = i
    if (input.charCodeAt(i) === codeMinus) {
      i++
      if (atEndOfNumber()) {
        repairNumberEndingWithNumericSymbol(start)
        return stack.update(Caret.afterValue)
      }
      if (!isDigit(input.charCodeAt(i))) {
        i = start
        return false
      }
    }

    // Note that in JSON leading zeros like "00789" are not allowed.
    // We will allow all leading zeros here though and at the end of parseNumber
    // check against trailing zeros and repair that if needed.
    // Leading zeros can have meaning, so we should not clear them.
    while (isDigit(input.charCodeAt(i))) {
      i++
    }

    if (input.charCodeAt(i) === codeDot) {
      i++
      if (atEndOfNumber()) {
        repairNumberEndingWithNumericSymbol(start)
        return stack.update(Caret.afterValue)
      }
      if (!isDigit(input.charCodeAt(i))) {
        i = start
        return false
      }
      while (isDigit(input.charCodeAt(i))) {
        i++
      }
    }

    if (input.charCodeAt(i) === codeLowercaseE || input.charCodeAt(i) === codeUppercaseE) {
      i++
      if (input.charCodeAt(i) === codeMinus || input.charCodeAt(i) === codePlus) {
        i++
      }
      if (atEndOfNumber()) {
        repairNumberEndingWithNumericSymbol(start)
        return stack.update(Caret.afterValue)
      }
      if (!isDigit(input.charCodeAt(i))) {
        i = start
        return false
      }
      while (isDigit(input.charCodeAt(i))) {
        i++
      }
    }

    // if we're not at the end of the number by this point, allow this to be parsed as another type
    if (!atEndOfNumber()) {
      i = start
      return false
    }

    if (i > start) {
      // repair a number with leading zeros like "00789"
      const num = input.substring(start, i)
      const hasInvalidLeadingZero = /^0\d/.test(num)

      output.push(hasInvalidLeadingZero ? `"${num}"` : num)
      return stack.update(Caret.afterValue)
    }

    return false
  }

  /**
   * Parse keywords true, false, null
   * Repair Python keywords True, False, None
   */
  function parseKeywords(): boolean {
    return (
      parseKeyword('true', 'true') ||
      parseKeyword('false', 'false') ||
      parseKeyword('null', 'null') ||
      // repair Python keywords True, False, None
      parseKeyword('True', 'true') ||
      parseKeyword('False', 'false') ||
      parseKeyword('None', 'null')
    )
  }

  function parseKeyword(name: string, value: string): boolean {
    if (input.substring(i, i + name.length) === name) {
      output.push(value)
      i += name.length
      return stack.update(Caret.afterValue)
    }

    return false
  }

  function parseUnquotedKey(): boolean {
    let end = findNextDelimiter(true, i)

    if (end !== null) {
      // first, go back to prevent getting trailing whitespaces in the string
      while (isWhitespace(input.charCodeAt(end - 1)) && end > i) {
        end--
      }

      const symbol = input.substring(i, end)
      output.push(JSON.stringify(symbol))
      i = end

      if (input.charCodeAt(i) === codeDoubleQuote) {
        // we had a missing start quote, but now we encountered the end quote, so we can skip that one
        i++
      }

      return stack.update(Caret.afterValue) // we do not have a state Caret.afterKey, therefore we use afterValue here
    }

    return false
  }

  function findNextDelimiter(isKey: boolean, start: number): number | null {
    // note that the symbol can end with whitespaces: we stop at the next delimiter
    // also, note that we allow strings to contain a slash / in order to support repairing regular expressions
    let j = start
    while (
      !input.isEnd(j) &&
      !isUnquotedStringDelimiter(input.charAt(j)) &&
      !isQuote(input.charCodeAt(j)) &&
      (!isKey || input.charCodeAt(j) !== codeColon)
    ) {
      j++
    }

    return j > i ? j : null
  }

  function prevNonWhitespaceIndex(start: number): number {
    let prev = start

    while (prev > 0 && isWhitespace(input.charCodeAt(prev))) {
      prev--
    }

    return prev
  }

  function atEndOfNumber() {
    return input.isEnd(i) || isDelimiter(input.charAt(i)) || isWhitespace(input.charCodeAt(i))
  }

  function repairNumberEndingWithNumericSymbol(start: number) {
    // repair numbers cut off at the end
    // this will only be called when we end after a '.', '-', or 'e' and does not
    // change the number more than it needs to make it valid JSON
    output.push(`${input.substring(start, i)}0`)
  }

  function throwInvalidCharacter(char: string) {
    throw new JSONRepairError(`Invalid character ${JSON.stringify(char)}`, i)
  }

  function throwUnexpectedCharacter() {
    throw new JSONRepairError(`Unexpected character ${JSON.stringify(input.charAt(i))}`, i)
  }

  function throwUnexpectedEnd() {
    throw new JSONRepairError('Unexpected end of json string', i)
  }

  function throwObjectKeyExpected() {
    throw new JSONRepairError('Object key expected', i)
  }

  function throwColonExpected() {
    throw new JSONRepairError('Colon expected', i)
  }

  function throwInvalidUnicodeCharacter() {
    const chars = input.substring(i, i + 6)
    throw new JSONRepairError(`Invalid unicode character "${chars}"`, i)
  }

  function atEndOfBlockComment(i: number) {
    return input.charAt(i) === '*' && input.charAt(i + 1) === '/'
  }

  return {
    transform,
    flush
  }
}
