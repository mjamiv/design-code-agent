vox2txt-beta

run using: gunicorn -c gunicorn_config.py -b 0.0.0.0:9000 -w 8 app:app --timeout 600


- **Framework & Libraries**: Uses Flask to build a web application, with additional libraries for handling documents (docx) and text analysis (TextBlob). OpenAI is used for specific tasks.
- **Audio Transcription**: Accepts an audio file and transcribes the text using OpenAI's `Audio.transcribe`.
- **Sentiment Analysis**: Analyzes the sentiment of the transcribed text as positive, negative, or neutral using TextBlob.
- **Key Points Extraction**: Extracts key points from the transcribed text using GPT-3.5-turbo.
- **Action Items Extraction**: Identifies tasks or action items in the text using GPT-3.5-turbo.
- **Abstract Summary**: Summarizes the transcribed text into an abstract summary using GPT-3.5-turbo.
- **Meeting Minutes Compilation**: Organizes the transcribed text, abstract summary, key points, action items, and sentiment into a DOCX document.
- **Web App Functions**: 
  - **Index Route**: Handles file upload, processes the audio file, extracts minutes, saves as DOCX, and displays the result.
  - **Download Route**: Allows downloading the created DOCX file.
- **File Formats**: Checks for supported audio file formats.
- **Error Handling**: Includes specific error handling related to file upload and transcription.

In simple terms, it's a web app to upload audio files of meetings, transcribe them, analyze the text for key points, actions, summary, and sentiment, and then save all this information into a downloadable DOCX file.
