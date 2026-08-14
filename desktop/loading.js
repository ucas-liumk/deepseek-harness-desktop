const strings = navigator.languages.some(language => language.toLowerCase().startsWith('zh'))
  ? {
      starting: '正在启动本地运行时…',
      failed: '非官方 DeepSeek Harness Desktop 无法启动。',
      close: '关闭',
    }
  : {
      starting: 'Starting the local runtime…',
      failed: 'Unofficial DeepSeek Harness Desktop could not start.',
      close: 'Close',
    }

const status = document.getElementById('status')
const detail = document.getElementById('error-detail')
const closeButton = document.getElementById('close-button')

status.textContent = strings.starting
closeButton.textContent = strings.close
closeButton.addEventListener('click', () => window.close())

window.desktopStartupError = (message) => {
  document.body.classList.add('failed')
  status.textContent = strings.failed
  detail.textContent = message
  detail.hidden = false
  closeButton.hidden = false
  closeButton.focus()
}
