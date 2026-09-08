import sys
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), 'app')))

from app.main import app

if __name__ == '__main__':
    print("Memulai server PotDeck Jalan Raya...")
    print("Akses melalui browser di http://localhost:7860")
    app.run(host='0.0.0.0', port=7860, debug=False, use_reloader=False, threaded=True)
