#!/usr/bin/env python3
"""
seed_large_random_fixed.py

Fixed and complete large randomized seeding script for the Restaurant POS backend.

- Connects to MongoDB (MONGO_URI env or default mongodb://localhost:27017/pos)
- Generates many realistic test documents across multiple restaurants & outlets:
  - Roles (global once)
  - N restaurants (default 5) each with 1..MAX_OUTLETS_PER_REST outlets
  - Suppliers
  - Inventory items per restaurant/outlet
  - Categories, menu items (with meta.recipe)
  - Tables per outlet
  - Users (SuperAdmin, Admin, Cashiers)
  - StockMovements (initial purchases + usage)
  - Orders (completed/pending/cancelled) per outlet
- Idempotent where reasonable (upserts for roles). Meant for dev/test only.

Prereqs:
  pip install pymongo python-dotenv faker bcrypt

Usage:
  export MONGO_URI="mongodb://localhost:27017/pos"
  python seed_large_random_fixed.py
"""

import os
import sys
import random
import uuid
from datetime import datetime, timezone
from pprint import pprint

from bson import ObjectId
from pymongo import MongoClient, ReturnDocument
from faker import Faker
import bcrypt

# Optional dotenv
try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

# ---------------- Config ----------------
MONGO_URI = os.environ.get("MONGO_URI", "mongodb://localhost:27017/pos")
N_RESTAURANTS = int(os.environ.get("N_RESTAURANTS", "5"))
MAX_OUTLETS_PER_REST = int(os.environ.get("MAX_OUTLETS_PER_REST", "2"))
MENU_ITEMS_PER_REST = int(os.environ.get("MENU_ITEMS_PER_REST", "60"))
INVENTORY_ITEMS_PER_REST = int(os.environ.get("INVENTORY_ITEMS_PER_REST", "40"))
TABLES_PER_OUTLET = int(os.environ.get("TABLES_PER_OUTLET", "12"))
ORDERS_PER_OUTLET = int(os.environ.get("ORDERS_PER_OUTLET", "30"))
DEFAULT_PASSWORD = os.environ.get("DEFAULT_PASSWORD", "cashier123")

fake = Faker()
Faker.seed(42)
random.seed(42)

# ---------------- Helpers ----------------
def now():
    return datetime.now(timezone.utc)

def oid():
    return ObjectId()

def uuid_short():
    return uuid.uuid4().hex[:6]

def hashed_password(password):
    pw = password.encode('utf-8')
    salt = bcrypt.gensalt(rounds=12)
    return bcrypt.hashpw(pw, salt).decode('utf-8')

def upsert_one(coll, filter_doc, set_doc):
    return coll.find_one_and_update(filter_doc, {'$set': set_doc}, upsert=True, return_document=ReturnDocument.AFTER)

def insert_one(coll, doc):
    return coll.insert_one(doc).inserted_id

def ensure_index(coll, keys, unique=False):
    try:
        coll.create_index(keys, unique=unique)
    except Exception as e:
        # Index already exists or minor conflict; continue
        print("Index creation warning:", e)

def generate_inventory_names(n):
    pool = [
        "Rice (kg)","Chicken (kg)","Canned Cola (pcs)","Burger Buns (pcs)","Lettuce (kg)","Tomato (kg)",
        "Cheese (kg)","Potato (kg)","Onion (kg)","Garlic (kg)","Oil (ltr)","Sugar (kg)","Salt (kg)",
        "Flour (kg)","Butter (kg)","Eggs (dozen)","Milk (ltr)","Yogurt (kg)","Paneer (kg)","Fish (kg)",
        "Pasta (kg)","Tomato Sauce (ltr)","Chilli Sauce (ltr)","Mayonnaise (ltr)","Bread Loaf (pcs)",
        "Veg Mix (kg)","Spice Mix (kg)","Coconut (pcs)","Coriander (kg)","Curry Leaves (kg)"
    ]
    if n <= len(pool):
        return pool[:n]
    names = pool[:]
    count = 0
    while len(names) < n:
        plural = random.choice(["(kg)","(pcs)","(ltr)", "(dozen)"])
        names.append(f"{fake.word().capitalize()} Ingredient {count} {plural}")
        count += 1
    return names[:n]

# ---------------- Main ----------------
def main():
    print("Connecting to MongoDB:", MONGO_URI)
    client = MongoClient(MONGO_URI)
    # prefer DB from URI otherwise fallback to 'pos'
    _default_db = client.get_default_database()
    db = _default_db if _default_db is not None else client["pos"]

    # Collections used by Node backend (names must match)
    roles_col = db["roles"]
    users_col = db["users"]
    restaurants_col = db["restaurants"]
    outlets_col = db["outlets"]
    suppliers_col = db["suppliers"]
    inventory_col = db["inventoryitems"]
    categories_col = db["categories"]
    menuitems_col = db["menuitems"]
    tables_col = db["tables"]
    stock_col = db["stockmovements"]
    orders_col = db["orders"]
    audit_col = db["auditlogs"]

    print("Ensuring indexes (idempotent) ...")
    ensure_index(roles_col, [("name", 1)], unique=True)
    ensure_index(users_col, [("email", 1)], unique=True)
    ensure_index(categories_col, [("restaurant", 1), ("name", 1)], unique=True)
    ensure_index(orders_col, [("restaurant", 1), ("outlet", 1), ("orderNumber", 1)], unique=True)

    # Seed global roles
    print("Seeding roles...")
    role_docs = [
        {"name": "SuperAdmin", "description": "Full access", "permissions": [], "scope": "global", "createdAt": now(), "updatedAt": now()},
        {"name": "Admin", "description": "Restaurant admin", "permissions": [], "scope": "restaurant", "createdAt": now(), "updatedAt": now()},
        {"name": "Cashier", "description": "Cashier - create orders & payments", "permissions": [], "scope": "restaurant", "createdAt": now(), "updatedAt": now()},
    ]
    for r in role_docs:
        upsert_one(roles_col, {"name": r["name"]}, r)
    roles_map = {r["name"]: roles_col.find_one({"name": r["name"]}) for r in role_docs}
    pprint({"seeded_roles": list(roles_map.keys())})

    # SuperAdmin user
    sa_email = os.environ.get("SUPERADMIN_EMAIL", "superadmin@example.com")
    sa_user = users_col.find_one({"email": sa_email})
    if not sa_user:
        print("Creating SuperAdmin user:", sa_email)
        sa_id = oid()
        users_col.insert_one({
            "_id": sa_id,
            "email": sa_email,
            "name": os.environ.get("SUPERADMIN_NAME", "Super Admin"),
            "passwordHash": hashed_password(os.environ.get("SUPERADMIN_PASSWORD", "superadmin123")),
            "roles": [roles_map["SuperAdmin"]["_id"]],
            "isActive": True,
            "createdAt": now(),
            "updatedAt": now()
        })
    else:
        print("SuperAdmin exists:", sa_email)

    all_restaurants = []
    print(f"Creating {N_RESTAURANTS} restaurants with outlets, inventory, menus, users, tables and orders ...")
    for r_index in range(N_RESTAURANTS):
        rest_name = f"{fake.company()} {random.choice(['Bistro','Cafe','Kitchen','Diner','Grill','House'])}"
        rest_doc = {
            "_id": oid(),
            "name": rest_name,
            "legalName": rest_name + " Pvt Ltd",
            "taxNumber": "GST" + uuid_short(),
            "ownerName": fake.name(),
            "contactEmail": fake.company_email(),
            "contactPhone": fake.phone_number(),
            "address": fake.address(),
            "cuisine": random.sample(["Indian","Italian","Continental","Asian","Mexican","Fusion"], k=2),
            "settings": {},
            "outlets": [],
            "createdAt": now(),
            "updatedAt": now()
        }
        restaurants_col.insert_one(rest_doc)

        # create 1..MAX_OUTLETS_PER_REST outlets
        num_outlets = random.randint(1, MAX_OUTLETS_PER_REST)
        outlet_ids = []
        for o in range(num_outlets):
            outlet_doc = {
                "_id": oid(),
                "name": f"{rest_doc['name']} - Outlet {o+1}",
                "code": f"OLT{random.randint(1000,9999)}",
                "address": fake.address(),
                "phone": fake.phone_number(),
                "timeZone": "Asia/Kolkata",
                "currency": random.choice(["INR","USD","EUR"]),
                "settings": {},
                "createdAt": now(),
                "updatedAt": now()
            }
            outlets_col.insert_one(outlet_doc)
            outlet_ids.append(outlet_doc["_id"])

        restaurants_col.update_one({"_id": rest_doc["_id"]}, {"$set": {"outlets": outlet_ids}})
        print(f"Created Restaurant: {rest_doc['name']} with {len(outlet_ids)} outlets")

        # create suppliers for this restaurant
        suppliers = []
        for s in range(2):
            sup = {"_id": oid(), "restaurant": rest_doc["_id"], "name": fake.company(), "contact": fake.name(), "phone": fake.phone_number(), "email": fake.company_email(), "address": fake.address(), "createdAt": now(), "updatedAt": now()}
            suppliers_col.insert_one(sup)
            suppliers.append(sup)

        # create inventory items for restaurant
        inv_items = []
        inv_names = generate_inventory_names(INVENTORY_ITEMS_PER_REST)
        for name in inv_names:
            inv = {
                "_id": oid(),
                "restaurant": rest_doc["_id"],
                "outlet": random.choice(outlet_ids),
                "name": name,
                "sku": f"INV-{name.replace(' ','').upper()[:12]}-{random.randint(100,999)}",
                "unit": random.choice(["kg","pcs","ltr"]),
                "costPrice": round(random.uniform(10,500),2),
                "currentQty": random.randint(30,300),
                "parLevel": random.randint(5,50),
                "supplier": random.choice(suppliers)["_id"],
                "isTracked": True,
                "location": "Main Store",
                "meta": {},
                "createdAt": now(),
                "updatedAt": now()
            }
            inv_items.append(inv)
        if inv_items:
            inventory_col.insert_many(inv_items)
        inv_map = {it["name"]: it for it in inv_items}

        # categories
        categories = []
        cat_names = random.sample(["Entrees","Burgers","Drinks","Desserts","Salads","Sides","Breakfast"], k=4)
        for i,cn in enumerate(cat_names):
            c = {"_id": oid(), "restaurant": rest_doc["_id"], "name": cn, "order": i+1, "isVisible": True, "createdAt": now(), "updatedAt": now()}
            categories_col.insert_one(c)
            categories.append(c)

        # menu items
        menu_items = []
        for m in range(MENU_ITEMS_PER_REST):
            cat = random.choice(categories)
            item_name = (fake.catch_phrase().split(" - ")[0][:30]).strip() + " " + random.choice(["Special","Deluxe","Classic","Platter","Bowl"])
            base_price = round(random.uniform(80,600),2)
            # build recipe: pick 1-4 inventory items
            recipe = []
            for _ in range(random.randint(1,4)):
                if not inv_items:
                    break
                inv_choice = random.choice(inv_items)
                qty = round(random.uniform(0.01, 1.5), 3) if inv_choice["unit"]=="kg" else random.randint(1,3)
                recipe.append({"inventoryItemId": inv_choice["_id"], "qty": qty, "unit": inv_choice["unit"]})
            menu = {
                "_id": oid(),
                "restaurant": rest_doc["_id"],
                "categories": [cat["_id"]],
                "name": item_name,
                "description": fake.sentence(nb_words=8),
                "image": None,
                "basePrice": base_price,
                "sku": f"MI-{random.randint(100000,999999)}",
                "isActive": True,
                "isTaxable": True,
                "variants": [],
                "modifiers": [{"name": "Extra", "price": round(base_price*0.25,2)}] if random.random() < 0.3 else [],
                "prepTimeMins": random.randint(2,25),
                "tags": [],
                "meta": {"recipe": recipe},
                "outletAvailability": [{"outlet": random.choice(outlet_ids), "isAvailable": True}],
                "createdAt": now(),
                "updatedAt": now()
            }
            menu_items.append(menu)
        if menu_items:
            menuitems_col.insert_many(menu_items)

        # tables per outlet
        for outlet_id in outlet_ids:
            tables = []
            for tnum in range(1, TABLES_PER_OUTLET+1):
                t = {
                    "_id": oid(),
                    "restaurant": rest_doc["_id"],
                    "outlet": outlet_id,
                    "name": f"Table {tnum}",
                    "seats": random.choice([2,4,6]),
                    "zone": random.choice(["Main Floor","Patio","Balcony"]),
                    "status": "available",
                    "meta": {},
                    "createdAt": now(),
                    "updatedAt": now()
                }
                tables.append(t)
            if tables:
                tables_col.insert_many(tables)

        # users: admin + cashiers
        admin_user = {
    "_id": oid(),
    "email": f"admin+{uuid_short()}@{fake.domain_name()}",
    "name": f"{rest_doc['name']} Admin",
    "passwordHash": hashed_password(DEFAULT_PASSWORD),
    "restaurant": rest_doc["_id"],
    "roles": [roles_map["Admin"]["_id"]],
    "isActive": True,
    "createdAt": now(),
    "updatedAt": now()
}

        users_col.insert_one(admin_user)
        for ccount in range(random.randint(1,3)):
            cash_user = {
    "_id": oid(),
    "email": f"cashier{ccount+1}-{uuid_short()}@{fake.domain_name()}",
    "name": f"Cashier {ccount+1} {rest_doc['name']}",
    "passwordHash": hashed_password(DEFAULT_PASSWORD),
    "restaurant": rest_doc["_id"],
    "roles": [roles_map["Cashier"]["_id"]],
    "outlet": random.choice(outlet_ids),
    "isActive": True,
    "createdAt": now(),
    "updatedAt": now()
}

            users_col.insert_one(cash_user)

        # initial stock movements
        stock_moves = []
        for inv in inv_items:
            stock_moves.append({
                "_id": oid(),
                "restaurant": rest_doc["_id"],
                "outlet": inv["outlet"],
                "inventoryItem": inv["_id"],
                "change": inv["currentQty"],
                "type": "purchase",
                "reference": f"INIT-{inv['_id']}",
                "note": "Initial stock seed",
                "performedBy": admin_user["_id"],
                "createdAt": now(),
                "updatedAt": now()
            })
        if stock_moves:
            stock_col.insert_many(stock_moves)

        # Create orders per outlet
        for outlet_id in outlet_ids:
            menus_for_outlet = list(menuitems_col.find({"restaurant": rest_doc["_id"], "outletAvailability.outlet": outlet_id}).limit(500))
            if not menus_for_outlet:
                menus_for_outlet = list(menuitems_col.find({"restaurant": rest_doc["_id"]}).limit(500))
            tables_for_outlet = list(tables_col.find({"restaurant": rest_doc["_id"], "outlet": outlet_id}))
            for ord_idx in range(ORDERS_PER_OUTLET):
                chosen_items = []
                for _ in range(random.randint(1,4)):
                    if not menus_for_outlet:
                        break
                    mi = random.choice(menus_for_outlet)
                    qty = random.choice([1,1,1,2])
                    chosen_items.append({
                        "menuItem": mi["_id"],
                        "name": mi["name"],
                        "qty": qty,
                        "price": mi["basePrice"]
                    })
                subtotal = sum(it["price"] * it["qty"] for it in chosen_items)
                status = random.choices(["completed","pending","cancelled"], weights=[0.6,0.25,0.15])[0]
                order_num = f"ORD-{int(datetime.now().timestamp())}-{random.randrange(1000,9999)}-{uuid_short()}"
                placed_by_user = admin_user["_id"]
                placed_at = now()
                table_for_order = random.choice(tables_for_outlet)["_id"] if tables_for_outlet else None

                order_doc = {
                    "_id": oid(),
                    "restaurant": rest_doc["_id"],
                    "outlet": outlet_id,
                    "table": table_for_order,
                    "orderNumber": order_num,
                    "type": "dine_in" if table_for_order else "counter",
                    "items": chosen_items,
                    "subtotal": subtotal,
                    "taxTotal": 0,
                    "discountTotal": 0,
                    "serviceCharge": 0,
                    "total": subtotal,
                    "payments": [{"method": "cash", "amount": subtotal, "transactionRef": f"TX-{order_num}", "paidAt": placed_at}] if status == "completed" else [],
                    "status": status,
                    "placedAt": placed_at,
                    "placedBy": placed_by_user,
                    "notes": "",
                    "meta": {"seed": True},
                    "createdAt": placed_at,
                    "updatedAt": placed_at
                }
                orders_col.insert_one(order_doc)

                # compute and apply consumption
                consumptions = {}
                for it in chosen_items:
                    menu_item = menuitems_col.find_one({"_id": it["menuItem"]})
                    recipe = (menu_item.get("meta") or {}).get("recipe", [])
                    for r in recipe:
                        iid = r["inventoryItemId"]
                        qty_needed = (r.get("qty", 0) or 0) * it["qty"]
                        consumptions[str(iid)] = consumptions.get(str(iid), 0) + qty_needed

                for iid_str, qty_needed in consumptions.items():
                    iid = ObjectId(iid_str)
                    inv_item = inventory_col.find_one({"_id": iid})
                    if not inv_item:
                        continue
                    new_qty = max(0, inv_item.get("currentQty", 0) - qty_needed)
                    inventory_col.update_one({"_id": iid}, {"$set": {"currentQty": new_qty, "updatedAt": now()}})
                    stock_col.insert_one({
                        "_id": oid(),
                        "restaurant": rest_doc["_id"],
                        "outlet": outlet_id,
                        "inventoryItem": iid,
                        "change": -abs(qty_needed),
                        "type": "usage",
                        "reference": f"SEED-ORD-{order_num}-{iid_str[:6]}",
                        "note": f"Seed consumption for order {order_num}",
                        "performedBy": placed_by_user,
                        "createdAt": now(),
                        "updatedAt": now()
                    })

                # update table occupancy if pending
                if table_for_order and status == "pending":
                    tables_col.update_one({"_id": table_for_order}, {"$set": {"status": "occupied", "currentOrder": order_doc["_id"], "updatedAt": now()}})
                elif table_for_order:
                    tables_col.update_one({"_id": table_for_order}, {"$set": {"status": "available", "currentOrder": None, "updatedAt": now()}})

        all_restaurants.append(rest_doc)

    print("\n=== SEEDING COMPLETE ===")
    print("Restaurants created:", len(all_restaurants))
    print("Sample restaurant names:")
    for r in all_restaurants[:5]:
        print(" -", r["name"])
    client.close()

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("Seeding failed:", e, file=sys.stderr)
        sys.exit(1)
