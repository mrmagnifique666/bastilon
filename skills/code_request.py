async def run(args, fetch, log, db, JSON, Date, Math, URL, URLSearchParams):
  code_change_request = args.get('code_change_request')
  reason = args.get('reason')

  if not code_change_request or not reason:
    return "Error: code_change_request and reason are required."

  #Basic formatting for the request
  request_text = f"Code Change Request:\n{code_change_request}\nReason:\n{reason}"

  #Log the request
  log(request_text)

  #Send to Nicolas via Telegram
  telegram_message = f"🛠️ Code Request:\n{code_change_request}\nReason:\n{reason}"
  await fetch('telegram.send', {'chatId': '8189338836', 'text': telegram_message})

  return "Code change request submitted."
