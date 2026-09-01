import json
import os

notebook_path = r"C:\ProjectSendiri\Deteksi_Lubang_JalanRaya\baches-unico-v1.ipynb"

# Baca isi notebook
with open(notebook_path, 'r', encoding='utf-8') as f:
    nb = json.load(f)

# Kode sel baru
new_cell = {
    "cell_type": "code",
    "execution_count": None,
    "metadata": {},
    "outputs": [],
    "source": [
        "# ============================================================\n",
        "# CELL: Konversi Pascal VOC (XML Bounding Box) ke YOLO Segmentation\n",
        "# Script ini dibuat otomatis untuk mengonversi anotasi XML dari annotated-images\n",
        "# ============================================================\n",
        "import os\n",
        "import xml.etree.ElementTree as ET\n",
        "\n",
        "def convert_voc_to_yolo_segmentation(xml_dir, classes):\n",
        "    total_converted = 0\n",
        "    for xml_file in os.listdir(xml_dir):\n",
        "        if not xml_file.endswith('.xml'):\n",
        "            continue\n",
        "            \n",
        "        xml_path = os.path.join(xml_dir, xml_file)\n",
        "        tree = ET.parse(xml_path)\n",
        "        root = tree.getroot()\n",
        "        \n",
        "        size = root.find('size')\n",
        "        if size is None: continue\n",
        "        width = float(size.find('width').text)\n",
        "        height = float(size.find('height').text)\n",
        "        if width == 0 or height == 0: continue\n",
        "            \n",
        "        txt_filename = xml_file.replace('.xml', '.txt')\n",
        "        txt_path = os.path.join(xml_dir, txt_filename)\n",
        "        \n",
        "        with open(txt_path, 'w') as out_file:\n",
        "            for obj in root.findall('object'):\n",
        "                class_name = obj.find('name').text\n",
        "                if class_name not in classes: continue\n",
        "                    \n",
        "                class_id = classes.index(class_name)\n",
        "                \n",
        "                bndbox = obj.find('bndbox')\n",
        "                xmin = float(bndbox.find('xmin').text)\n",
        "                ymin = float(bndbox.find('ymin').text)\n",
        "                xmax = float(bndbox.find('xmax').text)\n",
        "                ymax = float(bndbox.find('ymax').text)\n",
        "                \n",
        "                # Hitung poligon\n",
        "                x1, y1 = xmin / width, ymin / height\n",
        "                x2, y2 = xmax / width, ymin / height\n",
        "                x3, y3 = xmax / width, ymax / height\n",
        "                x4, y4 = xmin / width, ymax / height\n",
        "                \n",
        "                seg_str = f\"{class_id} {x1:.6f} {y1:.6f} {x2:.6f} {y2:.6f} {x3:.6f} {y3:.6f} {x4:.6f} {y4:.6f}\\n\"\n",
        "                out_file.write(seg_str)\n",
        "                \n",
        "        total_converted += 1\n",
        "    print(f\"\\u2705 Selesai! Berhasil mengonversi {total_converted} file XML menjadi anotasi YOLO Segmentation di folder: {xml_dir}\")\n",
        "\n",
        "kelas_dataset = [\"pothole\"] \n",
        "folder_dataset = r\"C:\\ProjectSendiri\\Deteksi_Lubang_JalanRaya\\annotated-images\"\n",
        "convert_voc_to_yolo_segmentation(folder_dataset, kelas_dataset)\n"
    ]
}

# Kita masukkan sel baru ini ke urutan ke-2 (index 1) di notebook
nb['cells'].insert(1, new_cell) 

# Tulis balik ke file
with open(notebook_path, 'w', encoding='utf-8') as f:
    json.dump(nb, f, indent=1)

print("Berhasil memasukkan script perhitungan ke dalam baches-unico-v1.ipynb!")
